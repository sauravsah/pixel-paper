/**
 * PIXEL PAPER — HTTP API
 * =============================
 *
 * Every route the browser can reach. The shape of this file follows one rule:
 *
 *   The browser may ask questions. It may not assert answers.
 *
 * It cannot set a price — prices are computed here from integer coordinates.
 * It cannot declare an area free — availability is checked here, under a lock.
 * It cannot declare a booking paid — only the webhook in webhook.ts does that,
 * and only after Dodo's signature has been verified.
 */

import express, { type Request, type Response, type Router } from 'express';

import { PRICING_CONFIG } from '../shared/pricing-config.ts';
import { buildPriceMap, calculateQuote } from '../shared/pricing.ts';
import { validateSelection } from '../shared/geometry.ts';
import { env } from './env.ts';
import { isDatabaseConfigured, pingDatabase } from './db.ts';
import * as repo from './repository.ts';
import { createCheckoutSession, isDodoConfigured, isTestMode, isWebhookConfigured } from './dodo.ts';
import { validateAdSubmission } from './validation.ts';
import { moderateAdSubmission } from './moderation.ts';
import { clientIp, createRateLimiter } from './rate-limit.ts';
import { ensureVisitorId } from './visitor.ts';

/** Booking ids are uuids. Anything else is a bad link, not a server fault. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Anti-spam for the one endpoint that creates bookings and calls the payment
 * provider. A single client IP gets a generous ceiling — enough that a real buyer
 * placing several spaces never trips it, low enough that a script hammering the
 * endpoint does. Loopback is exempt: that is the app (or the acceptance test)
 * talking to itself, the same self-trust the URL rules extend to localhost.
 * One shared instance, since the router is created once at boot.
 */
const checkoutLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 20,
  exemptLoopback: true,
});

/** Keep a noisy anonymous heartbeat from inflating the reader count. */
const visitorHeartbeatLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  exemptLoopback: false,
});

/**
 * Work out the origin to send the buyer back to after checkout.
 *
 * Prefers an explicit PUBLIC_BASE_URL, then the proxy headers a tunnel sets,
 * then the request's own Host. The Host header is attacker-controlled in
 * principle, so it is only ever used to build a return URL for the person
 * currently checking out — never to make a trust decision.
 */
function resolveBaseUrl(req: Request): string {
  if (env.publicBaseUrl) return env.publicBaseUrl.replace(/\/+$/, '');

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();

  const host = forwardedHost || req.get('host') || `localhost:${env.port}`;
  const proto = forwardedProto || (req.secure ? 'https' : 'http');

  return `${proto}://${host}`;
}

function requireDatabase(res: Response): boolean {
  if (isDatabaseConfigured()) return true;

  res.status(503).json({
    error: 'not-configured',
    message: 'The newspaper is not connected to its database yet. DATABASE_URL is missing.',
  });
  return false;
}

export function createApiRouter(): Router {
  const router = express.Router();

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Everything the client needs to draw and price the newspaper.
   *
   * No payment secret is part of this response, and no route can return one. The
   * checkout flow is a redirect to Dodo's hosted page, so the browser never needs
   * a payment key of any kind.
   */
  router.get('/config', (_req: Request, res: Response) => {
    res.json({
      pricing: PRICING_CONFIG,
      priceMap: buildPriceMap(PRICING_CONFIG),
      readiness: {
        database: isDatabaseConfigured(),
        payments: isDodoConfigured(),
        webhook: isWebhookConfigured(),
        testMode: isTestMode(),
      },
    });
  });

  router.get('/health', async (_req: Request, res: Response) => {
    let database = false;
    let databaseError: string | undefined;

    if (isDatabaseConfigured()) {
      try {
        await pingDatabase();
        database = true;
      } catch (err: any) {
        databaseError = err?.message || 'Database is unreachable.';
      }
    } else {
      databaseError = 'DATABASE_URL is missing.';
    }

    const payments = isDodoConfigured();
    const webhook = isWebhookConfigured();
    const ready = database && payments && webhook;

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'not-ready',
      database,
      payments,
      webhook,
      ...(databaseError ? { databaseError } : {}),
      time: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // The newspaper
  // -------------------------------------------------------------------------

  /** Record an anonymous reader heartbeat and return live/24-hour totals. */
  router.post('/viewers/heartbeat', async (req: Request, res: Response) => {
    if (!requireDatabase(res)) return;

    const limit = visitorHeartbeatLimiter.check(clientIp(req));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      res.status(429).json({
        error: 'rate-limited',
        message: 'Reader activity is updating too quickly. Please try again shortly.',
      });
      return;
    }

    try {
      const stats = await repo.recordVisitorHeartbeat(ensureVisitorId(req, res));
      res.setHeader('Cache-Control', 'no-store');
      res.json(stats);
    } catch (err: any) {
      console.error('[api] POST /viewers/heartbeat failed:', err.message);
      res.status(500).json({
        error: 'server-error',
        message: 'Could not update reader activity right now.',
      });
    }
  });

  /**
   * One request returns the whole readable state: which areas are taken, and
   * every live advertisement. The client polls this, so it stays a single round
   * trip.
   */
  router.get('/newspaper', async (_req: Request, res: Response) => {
    if (!requireDatabase(res)) return;

    try {
      await repo.expireStalePendingBookings();

      const [occupied, ads, stats] = await Promise.all([
        repo.listOccupiedAreas(),
        repo.listPlacedAds(),
        repo.getStats(),
      ]);

      res.json({ occupied, ads, stats });
    } catch (err: any) {
      console.error('[api] GET /newspaper failed:', err.message);
      res.status(500).json({ error: 'server-error', message: 'Could not load the newspaper.' });
    }
  });

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  /**
   * Authoritative price and availability for a rectangle.
   *
   * The client also runs the same pricing module locally so the figure updates
   * instantly while dragging, but this is the number that counts, and the client
   * replaces its own with this one on release.
   */
  router.post('/quote', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const validation = validateSelection(
      PRICING_CONFIG,
      body.pageNumber,
      body.x,
      body.y,
      body.width,
      body.height
    );

    if (!validation.ok || !validation.rect) {
      res.status(400).json({ error: validation.error, message: validation.message });
      return;
    }

    const pageNumber = Number(body.pageNumber);
    const quote = calculateQuote(PRICING_CONFIG, pageNumber, validation.rect);

    if (!isDatabaseConfigured()) {
      // Pricing is pure arithmetic and still correct without a database; only
      // availability is unknown.
      res.json({ quote, available: null });
      return;
    }

    try {
      const conflict = await repo.checkAvailability(pageNumber, validation.rect);
      res.json({
        quote,
        available: conflict === null,
        conflict: conflict ?? undefined,
      });
    } catch (err: any) {
      console.error('[api] POST /quote failed:', err.message);
      res.status(500).json({ error: 'server-error', message: 'Could not price that area.' });
    }
  });

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  /**
   * Start a purchase.
   *
   *   1. Validate the geometry.
   *   2. Validate the advertisement.
   *   3. Price it here, from the validated integers.
   *   4. Create a PENDING booking, under the page lock, only if the pixels are
   *      genuinely free.
   *   5. Create a Dodo checkout session for that server-computed amount.
   *
   * Nothing is permanent at the end of this. The booking is pending and the
   * pixels are only softly held. Payment is confirmed by webhook, never here.
   */
  router.post('/checkout', async (req: Request, res: Response) => {
    if (!requireDatabase(res)) return;

    if (!isDodoConfigured()) {
      res.status(503).json({
        error: 'payments-not-configured',
        message:
          'Payments are not enabled yet. Dodo Payments is not configured on the server.',
      });
      return;
    }

    // Anti-spam before any work: a flood of submissions from one source is turned
    // away here, before a booking is created or the payment provider is called.
    const limit = checkoutLimiter.check(clientIp(req));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      res.status(429).json({
        error: 'rate-limited',
        message: 'Too many checkout attempts from here just now. Please wait a moment and try again.',
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    const geometry = validateSelection(
      PRICING_CONFIG,
      body.pageNumber,
      body.x,
      body.y,
      body.width,
      body.height
    );

    if (!geometry.ok || !geometry.rect) {
      res.status(400).json({ error: geometry.error, message: geometry.message });
      return;
    }

    const adValidation = validateAdSubmission(body);
    if (!adValidation.ok) {
      res.status(400).json({
        error: 'invalid-advertisement',
        message: adValidation.errors[0].message,
        fields: adValidation.errors,
      });
      return;
    }

    // Shape is valid; now the publish-time policy. Is this ad safe to show and be
    // clicked on a page strangers read — no private/blocked destination, no stored
    // markup or script? Same `{error, message, fields}` shape as validation, so
    // the form displays a rejection here exactly as it does a validation error.
    const flags = moderateAdSubmission(adValidation.value);
    if (flags.length > 0) {
      res.status(400).json({
        error: 'content-blocked',
        message: flags[0].message,
        fields: flags,
      });
      return;
    }

    const pageNumber = Number(body.pageNumber);
    const rect = geometry.rect;
    const ad = adValidation.value;

    // The price. Computed here, from the validated rectangle. Any `price`,
    // `amount` or `total` in the request body is ignored entirely.
    const quote = calculateQuote(PRICING_CONFIG, pageNumber, rect);

    let bookingId: string | null = null;

    try {
      const created = await repo.createPendingBooking({
        pageNumber,
        rect,
        pixelCount: quote.pixelCount,
        pricePerPixel: quote.effectiveRate,
        effectivePrice: quote.totalPrice,
        amountCents: quote.amountCents,
        pageMultiplier: quote.pageMultiplier,
        positionMultiplier: quote.positionMultiplier,
        buyerEmail: ad.buyerEmail,
        // Cleared both validation and moderation above, so it is approved and will
        // go live the moment the webhook confirms payment.
        moderationStatus: 'approved',
        ad: {
          brandName: ad.brandName,
          headline: ad.headline,
          description: ad.description,
          destinationUrl: ad.destinationUrl,
          imageUrl: ad.imageUrl,
          ctaText: ad.ctaText,
        },
      });

      if (!created.ok) {
        res.status(409).json({
          error: 'area-unavailable',
          message:
            created.conflict.status === 'paid'
              ? 'Someone already owns part of that area. Pick a different space.'
              : 'Someone is checking out for part of that area right now. Try another space, or come back shortly.',
          conflict: created.conflict,
        });
        return;
      }

      bookingId = created.booking.id;

      const session = await createCheckoutSession(created.booking, resolveBaseUrl(req));
      await repo.attachCheckoutSession(created.booking.id, session.id);

      res.json({
        bookingId: created.booking.id,
        checkoutUrl: session.url,
        quote,
      });
    } catch (err: any) {
      // A booking with no usable session would hold pixels for nothing.
      if (bookingId) {
        await repo.cancelBooking(bookingId).catch(() => undefined);
      }

      console.error('[api] POST /checkout failed:', err.message);
      res.status(500).json({
        error: 'checkout-failed',
        message: 'Could not start the payment. Nothing has been charged.',
      });
    }
  });

  /**
   * Has the webhook confirmed this booking yet?
   *
   * The client polls this after returning from the payment provider. It reports
   * the status the database holds; it never sets it. A buyer who reloads the
   * success page a hundred times cannot make an unpaid booking look paid.
   */
  router.get('/checkout/status', async (req: Request, res: Response) => {
    if (!requireDatabase(res)) return;

    const bookingId = typeof req.query.booking_id === 'string' ? req.query.booking_id : '';
    if (!bookingId) {
      res.status(400).json({ error: 'missing-booking', message: 'No booking id supplied.' });
      return;
    }

    // A uuid column raises a type error on nonsense input, which would surface as
    // a 500 for what is plainly a bad link. Treat a malformed id as "no such
    // checkout" instead.
    if (!UUID_PATTERN.test(bookingId)) {
      res.status(404).json({ error: 'not-found', message: 'No such checkout.' });
      return;
    }

    try {
      const booking = await repo.getBookingById(bookingId);
      if (!booking) {
        res.status(404).json({ error: 'not-found', message: 'No such checkout.' });
        return;
      }

      const ad = await repo.getAdForBooking(booking.id);

      res.json({
        status: booking.status,
        booking: {
          id: booking.id,
          pageNumber: booking.pageNumber,
          x: booking.x,
          y: booking.y,
          width: booking.width,
          height: booking.height,
          pixelCount: booking.pixelCount,
          amountPaid: booking.status === 'paid' ? booking.effectivePrice : null,
          currency: booking.currency,
          claimedAt: booking.paidAt,
        },
        ad,
      });
    } catch (err: any) {
      console.error('[api] GET /checkout/status failed:', err.message);
      res.status(500).json({ error: 'server-error', message: 'Could not check that payment.' });
    }
  });

  /**
   * A single claimed space, for the shareable link in the confirmation screen.
   *
   * Only paid bookings are returned, and no price is included — a link someone
   * shares should not disclose what they paid.
   */
  router.get('/spaces/:id', async (req: Request, res: Response) => {
    if (!requireDatabase(res)) return;

    // Checked before the query because `id` is a uuid column: handing Postgres
    // 'nonsense' raises a type error, which would surface as a 500 for what is
    // plainly a 404. A mistyped link should not look like a broken server.
    if (!UUID_PATTERN.test(req.params.id)) {
      res.status(404).json({ error: 'not-found', message: 'No claimed space with that id.' });
      return;
    }

    try {
      const booking = await repo.getBookingById(req.params.id);
      if (!booking || booking.status !== 'paid') {
        res.status(404).json({ error: 'not-found', message: 'No claimed space with that id.' });
        return;
      }

      const ad = await repo.getAdForBooking(booking.id);

      res.json({
        booking: {
          id: booking.id,
          pageNumber: booking.pageNumber,
          x: booking.x,
          y: booking.y,
          width: booking.width,
          height: booking.height,
          pixelCount: booking.pixelCount,
          claimedAt: booking.paidAt,
        },
        ad,
      });
    } catch (err: any) {
      console.error('[api] GET /spaces/:id failed:', err.message);
      res.status(500).json({ error: 'server-error', message: 'Could not load that space.' });
    }
  });

  return router;
}
