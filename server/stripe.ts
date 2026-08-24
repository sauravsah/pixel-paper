/**
 * THE INTERNET TIMES — STRIPE
 * ===========================
 *
 * The only file that touches the Stripe SDK.
 *
 * `STRIPE_SECRET_KEY` is read here and used here. It is never returned by an
 * endpoint, never logged, and never imported by anything under src/. The browser
 * receives only the publishable key.
 *
 * No card details ever reach this server. The buyer types them on Stripe's
 * hosted Checkout page, on Stripe's domain. What comes back is a session id, a
 * payment intent id, and an amount.
 */

import Stripe from 'stripe';

import { env } from './env.ts';
import type { AdContent, BookingRecord } from './repository.ts';

let client: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(env.stripeSecretKey);
}

export function isWebhookConfigured(): boolean {
  return Boolean(env.stripeWebhookSecret);
}

function stripe(): Stripe {
  if (!env.stripeSecretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set.');
  }

  if (!client) {
    client = new Stripe(env.stripeSecretKey, {
      // Identifies this integration in the Stripe dashboard's logs.
      appInfo: { name: 'Pixel Paper', version: '1.0.0' },
    });
  }

  return client;
}

/**
 * True when the configured key is a test key.
 *
 * Surfaced in the UI so it is always obvious whether a real card would be
 * charged.
 */
export function isTestMode(): boolean {
  return env.stripeSecretKey?.startsWith('sk_test_') ?? false;
}

/**
 * Stripe fetches product images from its own servers, so a localhost URL cannot
 * work and would fail the whole session creation. Only publicly reachable https
 * images are passed along.
 */
function usableProductImage(imageUrl: string): string[] | undefined {
  if (!imageUrl) return undefined;

  try {
    const url = new URL(imageUrl);
    if (url.protocol !== 'https:') return undefined;
    if (url.hostname === 'localhost' || url.hostname.startsWith('127.')) return undefined;
    return [imageUrl];
  } catch {
    return undefined;
  }
}

export interface CheckoutSessionResult {
  id: string;
  url: string;
}

/**
 * Create a Stripe Checkout Session for a pending booking.
 *
 * `unit_amount` comes from `booking.amountCents`, which was computed on this
 * server from validated integer coordinates. No price submitted by a client is
 * involved at any point in this call.
 */
export async function createCheckoutSession(
  booking: BookingRecord,
  ad: AdContent,
  baseUrl: string
): Promise<CheckoutSessionResult> {
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: booking.currency,
          unit_amount: booking.amountCents,
          product_data: {
            name: `Page ${booking.pageNumber} — ${booking.width} x ${booking.height} px`,
            description:
              `Permanent placement in Pixel Paper. ` +
              `${booking.pixelCount.toLocaleString('en-US')} pixels at ` +
              `$${booking.pricePerPixel.toFixed(8)} each. One payment, no renewal.`,
            images: usableProductImage(ad.imageUrl),
          },
        },
      },
    ],
    customer_email: booking.buyerEmail ?? undefined,
    // Collect an email even when one was not supplied, so there is always a
    // receipt destination.
    customer_creation: booking.buyerEmail ? undefined : 'if_required',
    client_reference_id: booking.id,
    metadata: {
      bookingId: booking.id,
      pageNumber: String(booking.pageNumber),
      x: String(booking.x),
      y: String(booking.y),
      width: String(booking.width),
      height: String(booking.height),
    },
    payment_intent_data: {
      description: `Pixel Paper — page ${booking.pageNumber} permanent placement`,
      metadata: { bookingId: booking.id },
    },
    success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?checkout=cancelled&booking=${booking.id}`,
  });

  if (!session.url) {
    throw new Error('Stripe did not return a Checkout URL.');
  }

  return { id: session.id, url: session.url };
}

/**
 * Verify a webhook signature and return the event.
 *
 * Throws when the signature does not match, which is the only reason this
 * server ever believes a payment happened. An unsigned or wrongly signed request
 * — including one crafted by a browser — cannot get past this.
 */
export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  if (!env.stripeWebhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  }

  return stripe().webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
}

/**
 * Refund in full.
 *
 * Used when a payment is confirmed for pixels that someone else's payment
 * claimed a moment earlier. Losing a race must never cost the buyer money.
 */
export async function refundPayment(paymentIntentId: string): Promise<void> {
  await stripe().refunds.create({
    payment_intent: paymentIntentId,
    reason: 'requested_by_customer',
  });
}
