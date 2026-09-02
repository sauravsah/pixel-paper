/**
 * PIXEL PAPER — DODO PAYMENTS WEBHOOK
 * ==========================================
 *
 * The only place in this codebase where a booking becomes permanently claimed.
 *
 * Four things have to be true before that happens:
 *
 *   1. The request carries `webhook-id`, `webhook-timestamp` and
 *      `webhook-signature` headers that verify against DODO_PAYMENTS_WEBHOOK_KEY.
 *      A browser cannot produce them.
 *   2. The webhook id has not been handled before. Dodo retries, and can deliver
 *      the same event more than once even when nothing failed.
 *   3. The amount Dodo reports is at least the amount this server computed and
 *      stored on the booking. Dodo is a merchant of record and may add tax on
 *      top, so the collected total can legitimately exceed our price — but never
 *      fall short of it.
 *   4. The pixels are still free, re-checked under the page lock.
 *
 * If the fourth check fails — two people paid for overlapping pixels in the same
 * instant — the later payment is refunded in full and its booking cancelled.
 *
 * The raw request body is required for signature verification, so this handler is
 * mounted with `express.raw` BEFORE any JSON body parser. A parsed-and-restringified
 * body does not reproduce the exact bytes Dodo signed and verification fails.
 */

import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';

import * as repo from './repository.ts';
import { isDatabaseConfigured, lockRefund } from './db.ts';
import { env } from './env.ts';
import {
  constructWebhookEvent,
  hasVerifiedFullDiscount,
  isWebhookConfigured,
  refundPayment,
  type DodoWebhookEvent,
} from './dodo.ts';
import {
  isProviderAmountAcceptable,
  isProviderPaymentValid,
  paymentAmountsForOrder,
} from './payment-validation.ts';

/** Events this handler acts on. Anything else is acknowledged and ignored. */
const HANDLED_EVENTS = new Set(['payment.succeeded', 'payment.failed']);

export async function handleDodoWebhook(req: Request, res: Response): Promise<void> {
  if (!isWebhookConfigured()) {
    console.warn('[webhook] received an event but DODO_PAYMENTS_WEBHOOK_KEY is not set.');
    res.status(503).send('Webhook key not configured');
    return;
  }

  if (!isDatabaseConfigured()) {
    // 503 rather than 200: Dodo should retry once the database is reachable.
    console.error('[webhook] received an event but DATABASE_URL is not set.');
    res.status(503).send('Database not configured');
    return;
  }

  // Standard Webhooks signs the body against these three headers together.
  const webhookId = req.headers['webhook-id'];
  const webhookSignature = req.headers['webhook-signature'];
  const webhookTimestamp = req.headers['webhook-timestamp'];

  if (
    typeof webhookId !== 'string' ||
    typeof webhookSignature !== 'string' ||
    typeof webhookTimestamp !== 'string'
  ) {
    res.status(400).send('Missing webhook signature headers');
    return;
  }

  if (!Buffer.isBuffer(req.body)) {
    // Would mean a JSON parser ran first and the raw bytes are gone.
    console.error('[webhook] body is not raw; signature cannot be verified.');
    res.status(500).send('Webhook misconfigured');
    return;
  }

  let event: DodoWebhookEvent;
  try {
    event = constructWebhookEvent(req.body.toString('utf8'), {
      'webhook-id': webhookId,
      'webhook-signature': webhookSignature,
      'webhook-timestamp': webhookTimestamp,
    });
  } catch (err: any) {
    // Either a forgery or a key mismatch. Both are refusals.
    console.error('[webhook] signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (!HANDLED_EVENTS.has(event.type)) {
    res.json({ received: true, ignored: event.type });
    return;
  }

  // Idempotency. A replay returns 200 without repeating any work. Dodo's
  // `webhook-id` is stable per delivery, so it is the key. Dodo retries and can
  // deliver the same event more than once even without a failure, so this is a
  // normal path, not an error path.
  let claim: repo.WebhookEventClaim;
  try {
    claim = await repo.claimWebhookEvent(webhookId, event.type);
  } catch (err: any) {
    console.error('[webhook] could not record event id:', err.message);
    res.status(500).send('Could not record event');
    return;
  }

  if (!claim.firstTime) {
    console.log(`[webhook] ${webhookId} (${event.type}) already handled; ignoring replay.`);
    try {
      await claim.commit();
      res.json({ received: true, duplicate: true });
    } catch (err: any) {
      console.error('[webhook] could not finish duplicate claim:', err.message);
      res.status(500).send('Could not record event');
    }
    return;
  }

  try {
    await processClaimedWebhook(claim, async () => {
      switch (event.type) {
        case 'payment.succeeded':
          await onPaymentSucceeded(event.data, event.timestamp, claim.client);
          break;

        case 'payment.failed':
          await onPaymentFailed(event.data, claim.client);
          break;
      }
    });
    res.json({ received: true });
  } catch (err: any) {
    console.error(`[webhook] handling ${event.type} failed:`, err.message);
    res.status(500).send('Handler error');
  }
}

/** Pull our booking id back out of the metadata we set at checkout. */
function bookingIdFrom(data: Record<string, any>): string | null {
  const id = data?.metadata?.bookingId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function providerPaymentTimeMs(
  data: Record<string, any>,
  eventTimestamp?: string
): number | undefined {
  for (const value of [data.created_at, eventTimestamp]) {
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export interface ConflictRefundOperations {
  lockRefund: (transactionClient: PoolClient, paymentId: string) => Promise<void>;
  refundPayment: (paymentId: string) => Promise<void>;
  recordRefundedOrder: (
    input: repo.RefundRecord,
    transactionClient: PoolClient
  ) => Promise<void>;
}

/**
 * Complete a conflict refund before the webhook claim can commit. Both the
 * provider refund and its durable order record are deliberately allowed to
 * throw. The caller then rolls back the claim and returns HTTP 500 for retry.
 */
export async function processConflictRefund(
  paymentId: string,
  refundRecord: repo.RefundRecord,
  transactionClient: PoolClient,
  operations: ConflictRefundOperations = {
    lockRefund,
    refundPayment,
    recordRefundedOrder: (input, client) => repo.recordRefundedOrder(input, client),
  }
): Promise<void> {
  await operations.lockRefund(transactionClient, paymentId);
  await operations.refundPayment(paymentId);
  await operations.recordRefundedOrder(refundRecord, transactionClient);
}

/**
 * Keep the event claim open until all event work has completed. A failed
 * processor or commit is never acknowledged; release failures are logged but
 * still leave the request failed so the provider can retry.
 */
export async function processClaimedWebhook(
  claim: Pick<repo.WebhookEventClaim, 'commit' | 'release'>,
  process: () => Promise<void>
): Promise<void> {
  try {
    await process();
    await claim.commit();
  } catch (error) {
    try {
      await claim.release();
    } catch (releaseError: any) {
      console.error('[webhook] could not release failed event claim:', releaseError?.message);
    }
    throw error;
  }
}

async function onPaymentSucceeded(
  data: Record<string, any>,
  eventTimestamp: string | undefined,
  transactionClient: PoolClient
): Promise<void> {
  const bookingId = bookingIdFrom(data);
  if (!bookingId) {
    console.error('[webhook] payment.succeeded carried no bookingId in its metadata.');
    return;
  }

  const paymentId = typeof data.payment_id === 'string' && data.payment_id.length > 0
    ? data.payment_id
    : null;

  const booking = await repo.getBookingById(bookingId, transactionClient);
  if (!booking) {
    console.error(`[webhook] no booking for id ${bookingId}.`);
    return;
  }

  if (!booking.stripeSessionId || !env.dodoProductId || !isProviderPaymentValid(data, {
    currency: 'usd',
    productId: env.dodoProductId,
    checkoutSessionId: booking.stripeSessionId,
  })) {
    console.error(
      `[webhook] payment identity/status mismatch for booking ${bookingId}; no pixels claimed.`
    );
    return;
  }

  // Dodo is a merchant of record: the total it collects can include tax added on
  // top of our price, so the received amount must be at least what we charged,
  // not exactly equal. A total *below* our price is the anomaly, except for a
  // zero total backed by Dodo's verified 100% product-valid discount evidence.
  //
  // Deliberately not auto-refunded. An unexplained shortfall is the one case
  // where this server does not know what actually happened, and guessing with
  // someone else's money is worse than stopping and saying so. The booking lapses
  // with its hold on its own; the payment needs a human.
  const amountReceived = Number(data.total_amount ?? 0);
  const paymentTimeMs = providerPaymentTimeMs(data, eventTimestamp);
  const validFullDiscount =
    amountReceived === 0 &&
    paymentTimeMs !== undefined &&
    (await hasVerifiedFullDiscount(data, paymentTimeMs));
  if (!isProviderAmountAcceptable(booking.amountCents, amountReceived, validFullDiscount)) {
    console.error(
      `[webhook] amount too low on payment ${paymentId} for booking ${bookingId}: ` +
        `Dodo reported ${amountReceived} but the booking is ${booking.amountCents}. ` +
        `No pixels claimed. Review this payment in the Dodo dashboard and refund ` +
        `it by hand if it should not stand.`
    );
    return;
  }

  // The booking keeps the original/list amount. The existing order amount
  // fields record what the provider actually collected; the discount is the
  // difference between these linked records.
  const recordedAmounts = paymentAmountsForOrder(booking.amountCents, validFullDiscount);

  const currency = data.currency.toLowerCase();
  const buyerEmail =
    (typeof data?.customer?.email === 'string' ? data.customer.email : null) ??
    booking.buyerEmail ??
    null;

  const result = await repo.markBookingPaid({
    bookingId: booking.id,
    paymentId,
    // The order records the product amount after an approved discount, while the
    // booking retains the original/list amount. Any Dodo tax overage remains
    // outside this product-price record.
    amountCents: recordedAmounts.actualAmountCents,
    currency,
    buyerEmail,
  }, transactionClient);

  switch (result.outcome) {
    case 'paid':
      console.log(
        `[webhook] claimed: page ${result.booking.pageNumber} ` +
          `${result.booking.width}x${result.booking.height} at ` +
          `(${result.booking.x}, ${result.booking.y}) for ` +
          `$${result.booking.effectivePrice.toFixed(2)}.`
      );
      break;

    case 'already-paid':
      console.log(`[webhook] booking ${result.booking.id} was already paid; nothing to do.`);
      break;

    case 'conflict': {
      // Someone else's payment landed on these pixels first. Give the money back.
      console.warn(
        `[webhook] booking ${result.booking.id} lost a race for its pixels. Refunding.`
      );

      if (paymentId) {
        try {
          await processConflictRefund(paymentId, {
            bookingId: result.booking.id,
            // Key the refund row off the same value the paid path would use.
            sessionId: result.booking.stripeSessionId ?? paymentId,
            paymentIntentId: paymentId,
            amountCents: amountReceived,
            currency,
            buyerEmail: result.booking.buyerEmail,
          }, transactionClient);
          console.log(`[webhook] refunded ${paymentId} in full.`);
        } catch (refundErr: any) {
          // Loud and rethrown: the outer handler must roll back the claim and
          // return 500 so the provider can retry the durable refund record.
          console.error(
            `[webhook] REFUND PROCESSING FAILED for ${paymentId}: ${refundErr.message}.`
          );
          throw refundErr;
        }
      } else {
        console.error(
          `[webhook] booking ${result.booking.id} lost its pixels but the event ` +
            `carried no payment id. Refund booking ${bookingId} by hand.`
        );
      }
      break;
    }

    case 'not-found':
      console.error(`[webhook] booking ${bookingId} vanished.`);
      break;
  }
}

async function onPaymentFailed(
  data: Record<string, any>,
  transactionClient: PoolClient
): Promise<void> {
  const bookingId = bookingIdFrom(data);
  if (!bookingId) return;

  const booking = await repo.getBookingById(bookingId, transactionClient);
  if (!booking) return;

  // Never disturb a paid booking. A failure notice can arrive late, after another
  // signal already confirmed the money.
  if (booking.status === 'paid') return;

  await repo.cancelBooking(booking.id, transactionClient);
  console.log(`[webhook] released the hold on booking ${booking.id} after a failed payment.`);
}
