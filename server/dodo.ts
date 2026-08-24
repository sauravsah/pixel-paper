/**
 * THE INTERNET TIMES — DODO PAYMENTS
 * ==================================
 *
 * Every call to the payment provider goes through this file. Dodo Payments is the
 * one and only provider; there is no other, and no card data ever touches this
 * server.
 *
 * WHAT REACHES DODO, AND WHAT DOES NOT
 * ------------------------------------
 * A checkout session is created server-side for an amount this server computed
 * from integer coordinates — never a figure the browser supplied. The buyer is
 * redirected to Dodo's hosted page, types their card there, and is sent back with
 * nothing this server is willing to trust. A booking becomes paid only when
 * Dodo's signed webhook says the money moved (see webhook.ts).
 *
 * GRACEFUL WHEN UNCONFIGURED
 * --------------------------
 * The client is built lazily, so the newspaper boots and serves pages with no
 * Dodo credentials at all. `isDodoConfigured()` gates the checkout route; nothing
 * here runs until a purchase is actually attempted.
 */

import DodoPayments from 'dodopayments';
import { Webhook } from 'standardwebhooks';

import { env } from './env.ts';
import type { BookingRecord } from './repository.ts';

/**
 * A checkout needs both an API key to talk to Dodo and a product id to sell
 * against. Either one missing means checkout is switched off, not broken.
 */
export function isDodoConfigured(): boolean {
  return Boolean(env.dodoApiKey && env.dodoProductId);
}

/** A webhook can only be verified when its signing key is present. */
export function isWebhookConfigured(): boolean {
  return Boolean(env.dodoWebhookKey);
}

/** True unless the environment is explicitly set to live mode. */
export function isTestMode(): boolean {
  return env.dodoEnvironment !== 'live_mode';
}

// The client is created once, on first use, and reused thereafter.
let cachedClient: DodoPayments | null = null;

/**
 * The Dodo client. Constructed lazily so the server can start without any
 * credentials; the first checkout attempt is what brings it to life.
 */
function dodo(): DodoPayments {
  if (!env.dodoApiKey) {
    throw new Error('DODO_PAYMENTS_API_KEY is not set.');
  }
  if (!cachedClient) {
    cachedClient = new DodoPayments({
      bearerToken: env.dodoApiKey,
      environment: env.dodoEnvironment,
    });
  }
  return cachedClient;
}

export interface CheckoutSessionResult {
  /** Dodo's session id. Stored on the booking so the order can key off it. */
  id: string;
  /** The hosted page to redirect the buyer to. */
  url: string;
}

/**
 * Open a Dodo checkout session for one booking.
 *
 * The amount is the server-computed price in whole cents, passed as a
 * pay-what-you-want override on a single pre-configured product — so the figure
 * the buyer is charged is decided here, from the rectangle, and nowhere else. No
 * customer object is sent: buyers are never asked to sign in, and Dodo collects
 * the email it needs on its own page and returns it in the webhook.
 *
 * The booking id travels in `metadata`, which is how the webhook later finds its
 * way back to the right booking without trusting anything the browser returned.
 */
export async function createCheckoutSession(
  booking: BookingRecord,
  baseUrl: string
): Promise<CheckoutSessionResult> {
  if (!env.dodoProductId) {
    throw new Error('DODO_PRODUCT_ID is not set.');
  }

  const session = await dodo().checkoutSessions.create({
    product_cart: [
      {
        product_id: env.dodoProductId,
        quantity: 1,
        // Pay-what-you-want override, in the smallest currency unit (cents).
        amount: booking.amountCents,
      },
    ],
    // Everything the webhook needs to correlate the payment with this booking.
    // Values must be strings.
    metadata: {
      bookingId: booking.id,
      pageNumber: String(booking.pageNumber),
      x: String(booking.x),
      y: String(booking.y),
      width: String(booking.width),
      height: String(booking.height),
    },
    // Dodo appends its own query params (payment_id, status, email). The success
    // page reads only our booking id from this and then polls the server, which
    // reports what the webhook has already written — the return trip proves
    // nothing on its own.
    return_url: `${baseUrl}/?checkout=success&booking=${booking.id}`,
  });

  if (!session.checkout_url) {
    throw new Error('Dodo did not return a checkout URL.');
  }

  return { id: session.session_id, url: session.checkout_url };
}

/**
 * A verified webhook event. Dodo follows the Standard Webhooks spec, so the
 * envelope is `{ type, timestamp, data }`; `data` is the payment object.
 */
export interface DodoWebhookEvent {
  type: string;
  business_id?: string;
  timestamp?: string;
  data: Record<string, any>;
}

/**
 * Verify a webhook's signature and return its parsed body.
 *
 * `standardwebhooks` recomputes the HMAC over the exact raw bytes and the
 * `webhook-id`/`webhook-timestamp`/`webhook-signature` headers, and THROWS if it
 * does not match. A browser cannot forge this, which is why it — and only it —
 * may promote a booking to paid.
 */
export function constructWebhookEvent(
  rawBody: string,
  headers: Record<string, string>
): DodoWebhookEvent {
  if (!env.dodoWebhookKey) {
    throw new Error('DODO_PAYMENTS_WEBHOOK_KEY is not set.');
  }
  const webhook = new Webhook(env.dodoWebhookKey);
  return webhook.verify(rawBody, headers) as DodoWebhookEvent;
}

/**
 * Refund a payment in full.
 *
 * Used when a payment lands on pixels another buyer's confirmed payment already
 * took — nobody keeps money for pixels they did not get.
 */
export async function refundPayment(paymentId: string): Promise<void> {
  await dodo().refunds.create({ payment_id: paymentId });
}
