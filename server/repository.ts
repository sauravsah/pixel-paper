/**
 * PIXEL PAPER — DATA ACCESS
 * ================================
 *
 * Every read and write against the booking tables goes through this file.
 *
 * Two rules are enforced here and are the reason the rest of the system can be
 * trusted:
 *
 *   1. A rectangle is only ever confirmed free inside a transaction that holds
 *      the advisory lock for its page. Availability is never decided from
 *      anything the browser said, and never outside a lock.
 *
 *   2. A booking only becomes 'paid' in `markBookingPaid`, which is reachable
 *      solely from the signature-verified Dodo webhook. No HTTP route the
 *      browser can reach writes that value.
 */

import type { Pool, PoolClient } from 'pg';

import { PRICING_CONFIG } from '../shared/pricing-config.ts';
import type { Rect } from '../shared/pricing.ts';
import {
  LIVE_VISITOR_WINDOW_SECONDS,
  VISITOR_24H_WINDOW_SECONDS,
  type VisitorStats,
} from '../shared/visitor.ts';
import { getPool, lockPage, query, withTransaction } from './db.ts';

/** PostgreSQL SQLSTATE for a violated exclusion constraint. */
const EXCLUSION_VIOLATION = '23P01';

export type BookingStatus = 'pending' | 'paid' | 'cancelled';

/**
 * The time-based part of the inventory contract, kept pure for regression
 * tests. The SQL predicates below use the same half-open rule: a pending hold
 * is active strictly before its configured expiry, while a paid booking never
 * expires.
 */
export function bookingBlocksInventory(
  status: BookingStatus,
  createdAt: Date | string | number | null,
  now: Date | string | number = Date.now(),
  holdMinutes = PRICING_CONFIG.pendingHoldMinutes
): boolean {
  if (status === 'paid') return true;
  if (status !== 'pending' || createdAt === null) return false;

  const createdAtMs = createdAt instanceof Date
    ? createdAt.getTime()
    : typeof createdAt === 'number'
      ? createdAt
      : Date.parse(createdAt);
  const nowMs = now instanceof Date
    ? now.getTime()
    : typeof now === 'number'
      ? now
      : Date.parse(now);

  return Number.isFinite(createdAtMs) && Number.isFinite(nowMs)
    && createdAtMs > nowMs - holdMinutes * 60_000;
}

export interface OccupiedArea {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 'paid' is permanent. 'pending' is a temporary hold during someone's checkout. */
  status: 'paid' | 'pending';
}

export interface PlacedAd {
  bookingId: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelCount: number;
  brandName: string;
  headline: string;
  description: string;
  destinationUrl: string;
  imageUrl: string;
  ctaText: string;
  claimedAt: string | null;
}

export interface BookingRecord {
  id: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelCount: number;
  pricePerPixel: number;
  effectivePrice: number;
  amountCents: number;
  currency: string;
  pageMultiplier: number;
  positionMultiplier: number;
  status: BookingStatus;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  buyerEmail: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface AdContent {
  brandName: string;
  headline: string;
  description: string;
  destinationUrl: string;
  imageUrl: string;
  ctaText: string;
}

// ---------------------------------------------------------------------------
// Row mapping. `pg` hands NUMERIC back as a string, so every one is converted
// explicitly rather than left to surprise an arithmetic expression later.
// ---------------------------------------------------------------------------

function toBooking(row: Record<string, any>): BookingRecord {
  return {
    id: row.id,
    pageNumber: Number(row.page_number),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    pixelCount: Number(row.pixel_count),
    pricePerPixel: Number(row.price_per_pixel),
    effectivePrice: Number(row.effective_price),
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    pageMultiplier: Number(row.page_multiplier),
    positionMultiplier: Number(row.position_multiplier),
    status: row.status,
    stripeSessionId: row.stripe_session_id ?? null,
    stripePaymentIntentId: row.stripe_payment_intent_id ?? null,
    buyerEmail: row.buyer_email ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    paidAt: row.paid_at instanceof Date ? row.paid_at.toISOString() : row.paid_at ?? null,
  };
}

const BOOKING_COLUMNS = `
  id, page_number, x, y, width, height, pixel_count,
  price_per_pixel, effective_price, amount_cents, currency,
  page_multiplier, position_multiplier, status,
  stripe_session_id, stripe_payment_intent_id, buyer_email,
  created_at, paid_at
`;

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Release pixels held by checkouts that were started and abandoned.
 *
 * Called before availability is reported and before a new booking is created, so
 * a lapsed hold never blocks a real buyer. Cancelling is safe by construction:
 * the filter only ever matches rows still marked 'pending', and a webhook that
 * arrives late for one of these is handled explicitly in `markBookingPaid`,
 * which can revive a cancelled booking when the pixels are still free.
 */
export async function expireStalePendingBookings(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE pixel_bookings
        SET status = 'cancelled', updated_at = now()
      WHERE status = 'pending'
        AND created_at < now() - make_interval(mins => $1)
      RETURNING id`,
    [PRICING_CONFIG.pendingHoldMinutes]
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/**
 * Every area the browser must not allow a selection over: permanently claimed
 * pixels, plus pixels inside a live checkout hold.
 *
 * This is a convenience so the cursor behaves honestly. It is never the thing
 * that decides a sale — the server re-checks under a lock at checkout time.
 */
export async function listOccupiedAreas(): Promise<OccupiedArea[]> {
  const rows = await query<Record<string, any>>(
    `SELECT page_number, x, y, width, height, status
       FROM pixel_bookings
      WHERE status = 'paid'
         OR (status = 'pending' AND created_at > now() - make_interval(mins => $1))
      ORDER BY page_number, y, x`,
    [PRICING_CONFIG.pendingHoldMinutes]
  );

  return rows.map((row) => ({
    pageNumber: Number(row.page_number),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    status: row.status,
  }));
}

/**
 * Every live advertisement, for reading mode.
 *
 * Joins on status = 'paid' AND moderation_status = 'approved', so an unpaid
 * booking's creative is invisible no matter what else happened, and an ad taken
 * down by moderation drops off the page without touching the payment record.
 * Prices are deliberately not selected — what someone paid is nobody else's
 * business.
 */
export async function listPlacedAds(): Promise<PlacedAd[]> {
  const rows = await query<Record<string, any>>(
    `SELECT b.id            AS booking_id,
            b.page_number, b.x, b.y, b.width, b.height, b.pixel_count, b.paid_at,
            a.brand_name, a.headline, a.description,
            a.destination_url, a.image_url, a.cta_text
       FROM pixel_bookings b
       JOIN advertisements a ON a.booking_id = b.id
      WHERE b.status = 'paid'
        AND a.moderation_status = 'approved'
      ORDER BY b.page_number, b.y, b.x`
  );

  return rows.map((row) => ({
    bookingId: row.booking_id,
    pageNumber: Number(row.page_number),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    pixelCount: Number(row.pixel_count),
    brandName: row.brand_name,
    headline: row.headline,
    description: row.description ?? '',
    destinationUrl: row.destination_url,
    imageUrl: row.image_url ?? '',
    ctaText: row.cta_text ?? '',
    claimedAt: row.paid_at instanceof Date ? row.paid_at.toISOString() : row.paid_at ?? null,
  }));
}

export interface NewspaperStats {
  paidBookings: number;
  claimedPixels: number;
  totalPixels: number;
}

export async function getStats(): Promise<NewspaperStats> {
  const rows = await query<Record<string, any>>(
    `SELECT count(*)::int AS paid_bookings,
            COALESCE(sum(pixel_count), 0)::bigint AS claimed_pixels
       FROM pixel_bookings
      WHERE status = 'paid'`
  );

  const config = PRICING_CONFIG;

  return {
    paidBookings: Number(rows[0]?.paid_bookings ?? 0),
    claimedPixels: Number(rows[0]?.claimed_pixels ?? 0),
    totalPixels: config.pageWidth * config.pageHeight * config.totalPages,
  };
}

/** Touch one anonymous reader session and return the current presence totals. */
export async function recordVisitorHeartbeat(visitorId: string): Promise<VisitorStats> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO visitor_sessions (visitor_id)
       VALUES ($1)
       ON CONFLICT (visitor_id) DO UPDATE
         SET last_seen_at = now()`,
      [visitorId]
    );

    const result = await client.query<{ live_visitors: number; visitors_24h: number }>(
      `SELECT
         (SELECT count(*)::int
            FROM visitor_sessions
           WHERE last_seen_at >= now() - ($1 * interval '1 second')) AS live_visitors,
         (SELECT count(*)::int
            FROM visitor_sessions
           WHERE last_seen_at >= now() - ($2 * interval '1 second')) AS visitors_24h`,
      [LIVE_VISITOR_WINDOW_SECONDS, VISITOR_24H_WINDOW_SECONDS]
    );

    return {
      liveVisitors: Number(result.rows[0]?.live_visitors ?? 0),
      visitors24h: Number(result.rows[0]?.visitors_24h ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface Conflict {
  x: number;
  y: number;
  width: number;
  height: number;
  status: BookingStatus;
}

/**
 * Find a booking blocking `rect`, if any.
 *
 * The `x_range && … AND y_range && …` test is character-for-character the one
 * inside the exclusion constraint, so this check and the database's own
 * guarantee can never disagree about what counts as a collision. Rectangles that
 * merely touch edges are not conflicts, because the ranges are half-open.
 */
async function findConflict(
  client: PoolClient,
  pageNumber: number,
  rect: Rect,
  excludeBookingId?: string
): Promise<Conflict | null> {
  const result = await client.query<Record<string, any>>(
    `SELECT x, y, width, height, status
       FROM pixel_bookings
      WHERE page_number = $1
        AND x_range && int4range($2, $3)
        AND y_range && int4range($4, $5)
        AND ($6::uuid IS NULL OR id <> $6::uuid)
        AND (
              status = 'paid'
              OR (status = 'pending' AND created_at > now() - make_interval(mins => $7))
            )
      LIMIT 1`,
    [
      pageNumber,
      rect.x,
      rect.x + rect.width,
      rect.y,
      rect.y + rect.height,
      excludeBookingId ?? null,
      PRICING_CONFIG.pendingHoldMinutes,
    ]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    status: row.status,
  };
}

/** Read-only availability check, for the quote endpoint. */
export async function checkAvailability(
  pageNumber: number,
  rect: Rect
): Promise<Conflict | null> {
  return withTransaction((client) => findConflict(client, pageNumber, rect));
}

// ---------------------------------------------------------------------------
// Booking creation
// ---------------------------------------------------------------------------

export interface CreateBookingInput {
  pageNumber: number;
  rect: Rect;
  pixelCount: number;
  pricePerPixel: number;
  effectivePrice: number;
  amountCents: number;
  pageMultiplier: number;
  positionMultiplier: number;
  buyerEmail: string | null;
  /** The moderation decision made at submit time. A clean ad is 'approved'. */
  moderationStatus: 'pending' | 'approved' | 'rejected';
  ad: AdContent;
}

export type CreateBookingResult =
  | { ok: true; booking: BookingRecord }
  | { ok: false; conflict: Conflict };

/**
 * Create a pending booking and store its creative, atomically.
 *
 * The page is locked first, so the availability check and the insert cannot be
 * interleaved with a competing attempt on the same pixels. The booking is
 * created as 'pending' and nothing about it is permanent: it claims no pixels
 * beyond a soft hold until Dodo's webhook confirms real money arrived.
 */
export async function createPendingBooking(
  input: CreateBookingInput
): Promise<CreateBookingResult> {
  await expireStalePendingBookings();

  return withTransaction(async (client) => {
    await lockPage(client, input.pageNumber);

    const conflict = await findConflict(client, input.pageNumber, input.rect);
    if (conflict) return { ok: false, conflict };

    const bookingRows = await client.query<Record<string, any>>(
      `INSERT INTO pixel_bookings
         (page_number, x, y, width, height, pixel_count,
          price_per_pixel, effective_price, amount_cents,
          page_multiplier, position_multiplier, status, buyer_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)
       RETURNING ${BOOKING_COLUMNS}`,
      [
        input.pageNumber,
        input.rect.x,
        input.rect.y,
        input.rect.width,
        input.rect.height,
        input.pixelCount,
        input.pricePerPixel,
        input.effectivePrice,
        input.amountCents,
        input.pageMultiplier,
        input.positionMultiplier,
        input.buyerEmail,
      ]
    );

    const booking = toBooking(bookingRows.rows[0]);

    // Stored now so nothing the buyer typed is lost across the redirect to the
    // payment provider. Inert until the booking is paid, because every render
    // joins on status = 'paid'.
    await client.query(
      `INSERT INTO advertisements
         (booking_id, brand_name, headline, description, destination_url, image_url, cta_text, moderation_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        booking.id,
        input.ad.brandName,
        input.ad.headline,
        input.ad.description,
        input.ad.destinationUrl,
        input.ad.imageUrl,
        input.ad.ctaText,
        input.moderationStatus,
      ]
    );

    return { ok: true, booking };
  });
}

/** Record the Checkout Session id against a pending booking. */
export async function attachCheckoutSession(
  bookingId: string,
  sessionId: string
): Promise<void> {
  await query(
    `UPDATE pixel_bookings
        SET stripe_session_id = $2, updated_at = now()
      WHERE id = $1`,
    [bookingId, sessionId]
  );
}

/** Give the pixels straight back when a session could not be created. */
export async function cancelBooking(bookingId: string, client?: PoolClient): Promise<void> {
  const sql = `UPDATE pixel_bookings
        SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND status = 'pending'`;
  if (client) {
    await client.query(sql, [bookingId]);
    return;
  }
  await query(sql, [bookingId]);
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function getBookingById(
  bookingId: string,
  client?: PoolClient
): Promise<BookingRecord | null> {
  const sql = `SELECT ${BOOKING_COLUMNS} FROM pixel_bookings WHERE id = $1`;
  const rows = client
    ? (await client.query<Record<string, any>>(sql, [bookingId])).rows
    : await query<Record<string, any>>(sql, [bookingId]);
  return rows[0] ? toBooking(rows[0]) : null;
}

export async function getBookingBySessionId(
  sessionId: string
): Promise<BookingRecord | null> {
  const rows = await query<Record<string, any>>(
    `SELECT ${BOOKING_COLUMNS} FROM pixel_bookings WHERE stripe_session_id = $1`,
    [sessionId]
  );
  return rows[0] ? toBooking(rows[0]) : null;
}

export async function getAdForBooking(bookingId: string): Promise<AdContent | null> {
  const rows = await query<Record<string, any>>(
    `SELECT brand_name, headline, description, destination_url, image_url, cta_text
       FROM advertisements WHERE booking_id = $1`,
    [bookingId]
  );

  const row = rows[0];
  if (!row) return null;

  return {
    brandName: row.brand_name,
    headline: row.headline,
    description: row.description ?? '',
    destinationUrl: row.destination_url,
    imageUrl: row.image_url ?? '',
    ctaText: row.cta_text ?? '',
  };
}

// ---------------------------------------------------------------------------
// Webhook idempotency
// ---------------------------------------------------------------------------

export interface WebhookEventClaim {
  /** True only for the transaction that inserted this event id. */
  firstTime: boolean;
  /** The same transaction client, used for all webhook database work. */
  client: PoolClient;
  /** Commit the claim after event processing has completed successfully. */
  commit(): Promise<void>;
  /** Roll back the claim so the provider can retry after processing fails. */
  release(): Promise<void>;
}

type WebhookClaimPool = Pick<Pool, 'connect'>;

function destroyClaimClient(client: PoolClient): void {
  try {
    // Destroying a client with an open transaction causes PostgreSQL to roll it
    // back, which is the last-resort guarantee against a stuck claim.
    client.release(true);
  } catch {
    // pg's release is normally non-throwing. There is no further cleanup
    // possible if the client itself cannot be released.
  }
}

/**
 * Claim a webhook event id in a transaction held through event processing.
 *
 * The unique-key conflict intentionally waits for the first transaction to
 * commit or roll back. A duplicate therefore cannot be acknowledged while the
 * original is still running, and a failed original leaves the id retryable.
 * `poolOverride` is only used by pure tests; production uses the application
 * pool returned by `getPool()`.
 */
export async function claimWebhookEvent(
  eventId: string,
  eventType: string,
  poolOverride?: WebhookClaimPool
): Promise<WebhookEventClaim> {
  const client = await (poolOverride ?? getPool()).connect();
  let state: 'open' | 'committed' | 'released' = 'open';

  const closeClient = (destroy = false): void => {
    try {
      client.release(destroy);
    } catch (error) {
      if (!destroy) destroyClaimClient(client);
      throw error;
    }
  };

  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string }>(
      `INSERT INTO webhook_events (id, type)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [eventId, eventType]
    );

    const claim: WebhookEventClaim = {
      firstTime: result.rows.length > 0,
      client,

      async commit(): Promise<void> {
        if (state !== 'open') return;

        try {
          await client.query('COMMIT');
          state = 'committed';
          closeClient();
        } catch (error) {
          state = 'released';
          // The commit outcome may be uncertain. Destroying the client prevents
          // reuse of a possibly broken connection and lets retries reconcile via
          // the booking/order idempotency constraints.
          destroyClaimClient(client);
          throw error;
        }
      },

      async release(): Promise<void> {
        if (state !== 'open') return;

        try {
          await client.query('ROLLBACK');
          state = 'released';
          closeClient();
        } catch (error) {
          state = 'released';
          // If rollback failed, force-close the connection. PostgreSQL will roll
          // back the open transaction as the session disappears.
          destroyClaimClient(client);
          throw error;
        }
      },
    };

    return claim;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClaimClient(client);
      throw error;
    }

    try {
      closeClient();
    } catch {
      destroyClaimClient(client);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The one and only path to 'paid'
// ---------------------------------------------------------------------------

export type PaymentOutcome =
  | { outcome: 'paid'; booking: BookingRecord }
  | { outcome: 'already-paid'; booking: BookingRecord }
  | { outcome: 'conflict'; booking: BookingRecord; conflict: Conflict | null }
  | { outcome: 'not-found' };

export interface MarkPaidInput {
  bookingId: string;
  paymentId: string | null;
  amountCents: number;
  currency: string;
  buyerEmail: string | null;
}

/**
 * Promote a booking to permanently claimed. Called only from the webhook handler,
 * only after the Dodo signature has been verified.
 *
 * The page is locked and the rectangle re-checked against paid bookings one last
 * time. In the rare case two people paid for overlapping pixels in the same
 * moment, the first webhook to be processed wins and the second is reported as a
 * conflict so the caller can refund it in full — nobody keeps money for pixels
 * they did not get. The exclusion constraint is caught as a backstop in case the
 * conflicting row appears between the check and the update; that path is reported
 * as the same 'conflict' outcome, because a refusal from the database means
 * exactly what a refusal from the check means, and the buyer is owed their money
 * back either way. Reporting it as an error instead would leave Dodo retrying
 * an event that can never succeed while holding a charge nobody can honour.
 */
export async function markBookingPaid(
  input: MarkPaidInput,
  transactionClient?: PoolClient
): Promise<PaymentOutcome> {
  try {
    return await markBookingPaidInTransaction(input, transactionClient);
  } catch (err: any) {
    if (transactionClient || !err?.isOverlap || !err?.bookingId) throw err;

    // The transaction that hit the constraint is already dead, so the booking is
    // cancelled here, in its own statement, outside it.
    await query(
      `UPDATE pixel_bookings
          SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND status <> 'paid'`,
      [err.bookingId]
    );

    const booking = await getBookingById(err.bookingId);
    return booking ? { outcome: 'conflict', booking, conflict: null } : { outcome: 'not-found' };
  }
}

async function markBookingPaidInTransaction(
  input: MarkPaidInput,
  transactionClient?: PoolClient
): Promise<PaymentOutcome> {
  const run = async (client: PoolClient): Promise<PaymentOutcome> => {
    const existing = await client.query<Record<string, any>>(
      `SELECT ${BOOKING_COLUMNS} FROM pixel_bookings WHERE id = $1 FOR UPDATE`,
      [input.bookingId]
    );

    const row = existing.rows[0];
    if (!row) return { outcome: 'not-found' };

    const booking = toBooking(row);
    if (booking.status === 'paid') {
      return { outcome: 'already-paid', booking };
    }

    await lockPage(client, booking.pageNumber);

    const conflict = await findConflict(
      client,
      booking.pageNumber,
      { x: booking.x, y: booking.y, width: booking.width, height: booking.height },
      booking.id
    );

    // A live pending hold belonging to someone else is not a reason to reject
    // confirmed money — only pixels already paid for are.
    if (conflict && conflict.status === 'paid') {
      await client.query(
        `UPDATE pixel_bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [booking.id]
      );
      return { outcome: 'conflict', booking, conflict };
    }

    const savepoint = transactionClient ? 'SAVEPOINT pixel_press_paid_write' : null;
    if (savepoint) await client.query(savepoint);

    try {
      const updated = await client.query<Record<string, any>>(
        `UPDATE pixel_bookings
            SET status = 'paid',
                paid_at = now(),
                updated_at = now(),
                stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
                buyer_email = COALESCE($3, buyer_email)
          WHERE id = $1
          RETURNING ${BOOKING_COLUMNS}`,
        [booking.id, input.paymentId, input.buyerEmail]
      );

      const paid = toBooking(updated.rows[0]);

      // The order's unique key. Prefer the provider's session id (already stored
      // on the booking), fall back to the payment id, and finally the booking id
      // — always a stable, non-null value, which is what makes a replayed webhook
      // a no-op via ON CONFLICT rather than a second order row.
      const orderKey = paid.stripeSessionId ?? input.paymentId ?? paid.id;

      // pixel_bookings.amount_cents is the original/list amount. The existing
      // order amount fields record the product amount after an approved
      // discount, so a valid 100% discount is explicit as zero paid and the
      // discount is derivable as booking amount minus order amount.
      await client.query(
        `INSERT INTO orders
           (booking_id, stripe_session_id, stripe_payment_intent_id,
            amount, amount_cents, currency, status, buyer_email)
         VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7)
         ON CONFLICT (stripe_session_id) DO NOTHING`,
        [
          paid.id,
          orderKey,
          input.paymentId,
          input.amountCents / 100,
          input.amountCents,
          input.currency,
          input.buyerEmail,
        ]
      );

      if (savepoint) await client.query('RELEASE SAVEPOINT pixel_press_paid_write');
      return { outcome: 'paid', booking: paid };
    } catch (err: any) {
      if (err?.code === EXCLUSION_VIOLATION) {
        if (savepoint) {
          await client.query('ROLLBACK TO SAVEPOINT pixel_press_paid_write');
          await client.query(
            `UPDATE pixel_bookings
                SET status = 'cancelled', updated_at = now()
              WHERE id = $1 AND status <> 'paid'`,
            [booking.id]
          );
          const cancelled = await client.query<Record<string, any>>(
            `SELECT ${BOOKING_COLUMNS} FROM pixel_bookings WHERE id = $1`,
            [booking.id]
          );
          return {
            outcome: 'conflict',
            booking: cancelled.rows[0] ? toBooking(cancelled.rows[0]) : booking,
            conflict,
          };
        }

        // The database refused the overlap. This is the guarantee working.
        throw Object.assign(
          new Error('overlap-rejected-by-database'),
          { bookingId: booking.id, isOverlap: true }
        );
      }
      throw err;
    }
  };

  return transactionClient ? run(transactionClient) : withTransaction(run);
}

export interface RefundRecord {
  bookingId: string;
  sessionId: string;
  paymentIntentId: string | null;
  amountCents: number;
  currency: string;
  buyerEmail: string | null;
}

/**
 * Record that money arrived and was sent back.
 *
 * A booking that loses a race for its pixels never reaches the success path, so
 * it has no order row to update — which would make a bare `UPDATE orders` a
 * silent no-op and leave a refunded payment with no trace in this database at
 * all. The row is written here instead, already marked refunded, so the money in
 * and the money out are both accounted for.
 */
export async function recordRefundedOrder(
  input: RefundRecord,
  client?: PoolClient
): Promise<void> {
  const sql = `INSERT INTO orders
       (booking_id, stripe_session_id, stripe_payment_intent_id,
        amount, amount_cents, currency, status, buyer_email)
     VALUES ($1, $2, $3, $4, $5, $6, 'refunded', $7)
     ON CONFLICT (stripe_session_id)
       DO UPDATE SET status = 'refunded',
                     stripe_payment_intent_id =
                       COALESCE(EXCLUDED.stripe_payment_intent_id, orders.stripe_payment_intent_id)`;
  const params = [
    input.bookingId,
    input.sessionId,
    input.paymentIntentId,
    input.amountCents / 100,
    input.amountCents,
    input.currency,
    input.buyerEmail,
  ];
  if (client) {
    await client.query(sql, params);
    return;
  }
  await query(sql, params);
}
