/**
 * THE INTERNET TIMES — STRIPE WEBHOOK
 * ===================================
 *
 * The only place in this codebase where a booking becomes permanently claimed.
 *
 * Four things have to be true before that happens:
 *
 *   1. The request carries a `stripe-signature` header that verifies against
 *      STRIPE_WEBHOOK_SECRET. A browser cannot produce one.
 *   2. The event id has not been handled before. Stripe retries, and can deliver
 *      the same event more than once even when nothing failed.
 *   3. The amount Stripe reports matches the amount this server computed and
 *      stored on the booking.
 *   4. The pixels are still free, re-checked under the page lock.
 *
 * If the fourth check fails — two people paid for overlapping pixels in the same
 * instant — the later payment is refunded in full and its booking cancelled.
 *
 * The raw request body is required for signature verification, so this handler is
 * mounted with `express.raw` BEFORE any JSON body parser. A parsed-and-restringified
 * body does not reproduce the exact bytes Stripe signed and verification fails.
 */

import type { Request, Response } from 'express';
import type Stripe from 'stripe';

import * as repo from './repository.ts';
import { isDatabaseConfigured } from './db.ts';
import {
  constructWebhookEvent,
  isWebhookConfigured,
  refundPayment,
} from './stripe.ts';

/** Events this handler acts on. Anything else is acknowledged and ignored. */
const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  if (!isWebhookConfigured()) {
    console.warn('[webhook] received an event but STRIPE_WEBHOOK_SECRET is not set.');
    res.status(503).send('Webhook secret not configured');
    return;
  }

  if (!isDatabaseConfigured()) {
    // 503 rather than 200: Stripe should retry once the database is reachable.
    console.error('[webhook] received an event but DATABASE_URL is not set.');
    res.status(503).send('Database not configured');
    return;
  }

  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    res.status(400).send('Missing stripe-signature header');
    return;
  }

  if (!Buffer.isBuffer(req.body)) {
    // Would mean a JSON parser ran first and the raw bytes are gone.
    console.error('[webhook] body is not raw; signature cannot be verified.');
    res.status(500).send('Webhook misconfigured');
    return;
  }

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err: any) {
    // Either a forgery or a secret mismatch. Both are refusals.
    console.error('[webhook] signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (!HANDLED_EVENTS.has(event.type)) {
    res.json({ received: true, ignored: event.type });
    return;
  }

  // Idempotency. A replay returns 200 without repeating any work.
  let firstTime: boolean;
  try {
    firstTime = await repo.claimWebhookEvent(event.id, event.type);
  } catch (err: any) {
    console.error('[webhook] could not record event id:', err.message);
    res.status(500).send('Could not record event');
    return;
  }

  if (!firstTime) {
    console.log(`[webhook] ${event.id} (${event.type}) already handled; ignoring replay.`);
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await onPaymentSucceeded(event.data.object as Stripe.Checkout.Session);
        break;

      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        await onCheckoutAbandoned(event.data.object as Stripe.Checkout.Session);
        break;
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error(`[webhook] handling ${event.type} failed:`, err.message);
    // 500 asks Stripe to retry. The event id was already claimed, so the retry
    // would be skipped as a duplicate — release it so the retry can do the work.
    await repo.releaseWebhookEvent(event.id).catch(() => undefined);
    res.status(500).send('Handler error');
  }
}

async function onPaymentSucceeded(session: Stripe.Checkout.Session): Promise<void> {
  // An asynchronous payment method can complete the session while the money is
  // still pending. Only 'paid' means funds are secured.
  if (session.payment_status !== 'paid') {
    console.log(`[webhook] session ${session.id} is ${session.payment_status}; waiting.`);
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  const booking = await repo.getBookingBySessionId(session.id);
  if (!booking) {
    console.error(`[webhook] no booking for session ${session.id}.`);
    return;
  }

  // Guard against a session whose amount does not match what this server priced.
  // Should be impossible — the amount was set server-side when the session was
  // created — so a mismatch means something is wrong and no pixels are claimed.
  //
  // Deliberately not auto-refunded. An unexplained mismatch is the one case where
  // this server does not know what actually happened, and guessing with someone
  // else's money is worse than stopping and saying so. The booking lapses with
  // its hold on its own; the payment needs a human.
  const amountReceived = session.amount_total ?? 0;
  if (amountReceived !== booking.amountCents) {
    console.error(
      `[webhook] amount mismatch on session ${session.id}: ` +
        `Stripe reported ${amountReceived} but the booking is ${booking.amountCents}. ` +
        `No pixels claimed. Review this payment in the Stripe dashboard and refund ` +
        `it by hand if it should not stand.`
    );
    return;
  }

  const result = await repo.markBookingPaid({
    sessionId: session.id,
    paymentIntentId,
    amountCents: amountReceived,
    currency: session.currency ?? booking.currency,
    buyerEmail:
      session.customer_details?.email ?? session.customer_email ?? booking.buyerEmail ?? null,
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

      if (paymentIntentId) {
        try {
          await refundPayment(paymentIntentId);
          await repo.recordRefundedOrder({
            bookingId: result.booking.id,
            sessionId: session.id,
            paymentIntentId,
            amountCents: amountReceived,
            currency: session.currency ?? result.booking.currency,
            buyerEmail: result.booking.buyerEmail,
          });
          console.log(`[webhook] refunded ${paymentIntentId} in full.`);
        } catch (refundErr: any) {
          // Loud, because a human now needs to refund this by hand.
          console.error(
            `[webhook] REFUND FAILED for ${paymentIntentId}: ${refundErr.message}. ` +
              `Refund this payment manually in the Stripe dashboard.`
          );
        }
      } else {
        console.error(
          `[webhook] booking ${result.booking.id} lost its pixels but the session ` +
            `carried no payment intent. Refund session ${session.id} by hand.`
        );
      }
      break;
    }

    case 'not-found':
      console.error(`[webhook] booking for session ${session.id} vanished.`);
      break;
  }
}

async function onCheckoutAbandoned(session: Stripe.Checkout.Session): Promise<void> {
  const booking = await repo.getBookingBySessionId(session.id);
  if (!booking) return;

  // Never disturb a paid booking. Expiry events can arrive after payment.
  if (booking.status === 'paid') return;

  await repo.cancelBooking(booking.id);
  console.log(`[webhook] released the hold on booking ${booking.id}.`);
}
