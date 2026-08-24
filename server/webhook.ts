/**
 * THE INTERNET TIMES — DODO PAYMENTS WEBHOOK
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

import * as repo from './repository.ts';
import { isDatabaseConfigured } from './db.ts';
import {
  constructWebhookEvent,
  isWebhookConfigured,
  refundPayment,
  type DodoWebhookEvent,
} from './dodo.ts';

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
  let firstTime: boolean;
  try {
    firstTime = await repo.claimWebhookEvent(webhookId, event.type);
  } catch (err: any) {
    console.error('[webhook] could not record event id:', err.message);
    res.status(500).send('Could not record event');
    return;
  }

  if (!firstTime) {
    console.log(`[webhook] ${webhookId} (${event.type}) already handled; ignoring replay.`);
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    switch (event.type) {
      case 'payment.succeeded':
        await onPaymentSucceeded(event.data);
        break;

      case 'payment.failed':
        await onPaymentFailed(event.data);
        break;
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error(`[webhook] handling ${event.type} failed:`, err.message);
    // 500 asks Dodo to retry. The event id was already claimed, so the retry
    // would be skipped as a duplicate — release it so the retry can do the work.
    await repo.releaseWebhookEvent(webhookId).catch(() => undefined);
    res.status(500).send('Handler error');
  }
}

/** Pull our booking id back out of the metadata we set at checkout. */
function bookingIdFrom(data: Record<string, any>): string | null {
  const id = data?.metadata?.bookingId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function onPaymentSucceeded(data: Record<string, any>): Promise<void> {
  const bookingId = bookingIdFrom(data);
  if (!bookingId) {
    console.error('[webhook] payment.succeeded carried no bookingId in its metadata.');
    return;
  }

  const paymentId = typeof data.payment_id === 'string' ? data.payment_id : null;

  const booking = await repo.getBookingById(bookingId);
  if (!booking) {
    console.error(`[webhook] no booking for id ${bookingId}.`);
    return;
  }

  // Dodo is a merchant of record: the total it collects can include tax added on
  // top of our price, so the received amount must be at least what we charged,
  // not exactly equal. A total *below* our price is the anomaly.
  //
  // Deliberately not auto-refunded. An unexplained shortfall is the one case
  // where this server does not know what actually happened, and guessing with
  // someone else's money is worse than stopping and saying so. The booking lapses
  // with its hold on its own; the payment needs a human.
  const amountReceived = Number(data.total_amount ?? 0);
  if (!Number.isFinite(amountReceived) || amountReceived < booking.amountCents) {
    console.error(
      `[webhook] amount too low on payment ${paymentId} for booking ${bookingId}: ` +
        `Dodo reported ${amountReceived} but the booking is ${booking.amountCents}. ` +
        `No pixels claimed. Review this payment in the Dodo dashboard and refund ` +
        `it by hand if it should not stand.`
    );
    return;
  }

  const currency =
    typeof data.currency === 'string' && data.currency
      ? data.currency.toLowerCase()
      : booking.currency;
  const buyerEmail =
    (typeof data?.customer?.email === 'string' ? data.customer.email : null) ??
    booking.buyerEmail ??
    null;

  const result = await repo.markBookingPaid({
    bookingId: booking.id,
    paymentId,
    // The order records what this server priced, not the tax-inclusive total, so
    // it reflects the sale. Any overage is Dodo's tax, not our revenue.
    amountCents: booking.amountCents,
    currency,
    buyerEmail,
  });

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
          await refundPayment(paymentId);
          await repo.recordRefundedOrder({
            bookingId: result.booking.id,
            // Key the refund row off the same value the paid path would use.
            sessionId: result.booking.stripeSessionId ?? paymentId,
            paymentIntentId: paymentId,
            amountCents: amountReceived,
            currency,
            buyerEmail: result.booking.buyerEmail,
          });
          console.log(`[webhook] refunded ${paymentId} in full.`);
        } catch (refundErr: any) {
          // Loud, because a human now needs to refund this by hand.
          console.error(
            `[webhook] REFUND FAILED for ${paymentId}: ${refundErr.message}. ` +
              `Refund this payment manually in the Dodo dashboard.`
          );
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

async function onPaymentFailed(data: Record<string, any>): Promise<void> {
  const bookingId = bookingIdFrom(data);
  if (!bookingId) return;

  const booking = await repo.getBookingById(bookingId);
  if (!booking) return;

  // Never disturb a paid booking. A failure notice can arrive late, after another
  // signal already confirmed the money.
  if (booking.status === 'paid') return;

  await repo.cancelBooking(booking.id);
  console.log(`[webhook] released the hold on booking ${booking.id} after a failed payment.`);
}
