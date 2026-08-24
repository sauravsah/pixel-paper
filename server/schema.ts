/**
 * THE INTERNET TIMES — DATABASE SCHEMA
 * ===================================
 *
 * The schema lives here as a string rather than a .sql file so that esbuild
 * bundles it straight into dist/server.cjs. There is no runtime file to lose.
 *
 * Every statement is idempotent. Running the migration repeatedly is safe and is
 * exactly what happens on every server boot.
 *
 * PAYMENT DATA
 * ------------
 * No card numbers, CVCs, expiry dates or raw payment credentials are stored
 * anywhere in this schema, and none are ever received by this server. Card entry
 * happens entirely on Stripe's hosted Checkout page. All this database keeps are
 * Stripe's own opaque identifiers (session id, payment intent id), the amount,
 * and the buyer's email address.
 *
 * HOW DOUBLE-SELLING IS MADE IMPOSSIBLE
 * -------------------------------------
 * `pixel_bookings` carries two generated columns, `x_range` and `y_range`, each
 * an `int4range` over the pixels the booking spans. `pixel_bookings_no_overlap`
 * is an EXCLUDE constraint requiring that no two paid bookings on the same page
 * overlap in both axes at once — which is precisely what it means for two
 * rectangles to share a pixel. Two paid bookings covering the same pixel cannot
 * both exist; PostgreSQL rejects the second one.
 *
 * This is the bottom-most guarantee in the system. It holds even if the
 * application logic above it is wrong, under any amount of concurrency, across
 * any number of server processes, and regardless of what any client sends.
 *
 * Ranges are used rather than a geometric `box` for two reasons. Range
 * constructors are unambiguously immutable, which a generated column requires.
 * And `int4range(x, x + width)` defaults to '[)' bounds — inclusive start,
 * exclusive end — which is exactly the half-open convention in
 * shared/geometry.ts. A block spanning x 0-99 and one starting at x = 100 do not
 * overlap, in the database and in the application, by construction rather than
 * by coincidence.
 */

export const SCHEMA_SQL = `
-- Needed so an integer column (page_number) can take part in a GiST exclusion
-- constraint alongside a geometric column.
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ---------------------------------------------------------------------------
-- newspaper_pages — the six permanent pages. Never more, never fewer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS newspaper_pages (
  id           SERIAL PRIMARY KEY,
  page_number  INTEGER NOT NULL UNIQUE CHECK (page_number > 0),
  width        INTEGER NOT NULL CHECK (width > 0),
  height       INTEGER NOT NULL CHECK (height > 0),
  base_rate    NUMERIC(16, 10) NOT NULL CHECK (base_rate >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- pixel_bookings — one row per attempted purchase of a rectangle.
--
--   pending    a Checkout Session exists but Stripe has not confirmed payment.
--              Holds the pixels softly, for pendingHoldMinutes, then lapses.
--   paid       Stripe's signed webhook confirmed the payment. Permanent.
--   cancelled  abandoned or expired. Releases the pixels.
--
-- Only 'paid' rows are covered by the exclusion constraint, so only real,
-- confirmed money can permanently claim pixels.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pixel_bookings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_number              INTEGER NOT NULL REFERENCES newspaper_pages (page_number),
  x                        INTEGER NOT NULL CHECK (x >= 0),
  y                        INTEGER NOT NULL CHECK (y >= 0),
  width                    INTEGER NOT NULL CHECK (width > 0),
  height                   INTEGER NOT NULL CHECK (height > 0),
  pixel_count              INTEGER NOT NULL CHECK (pixel_count > 0),

  -- What one pixel in this exact rectangle cost: base_rate x page x position.
  price_per_pixel          NUMERIC(16, 10) NOT NULL CHECK (price_per_pixel >= 0),
  -- Total in dollars, for display and reporting.
  effective_price          NUMERIC(12, 2) NOT NULL CHECK (effective_price >= 0),
  -- Total in whole cents. This is the figure that was sent to Stripe, and the
  -- one the webhook checks the received amount against.
  amount_cents             INTEGER NOT NULL CHECK (amount_cents > 0),
  currency                 TEXT NOT NULL DEFAULT 'usd',

  -- Kept for auditing so an old booking can always be explained, even after
  -- the multipliers in the config are changed.
  page_multiplier          NUMERIC(8, 4) NOT NULL,
  position_multiplier      NUMERIC(8, 6) NOT NULL,

  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'paid', 'cancelled')),

  stripe_session_id        TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  buyer_email              TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                  TIMESTAMPTZ,

  -- Generated, never written by the application: the pixel spans this booking
  -- owns. '[)' bounds mean a block ending at 99 does not touch one starting
  -- at 100.
  x_range INT4RANGE GENERATED ALWAYS AS (int4range(x, x + width)) STORED,
  y_range INT4RANGE GENERATED ALWAYS AS (int4range(y, y + height)) STORED
);

COMMENT ON TABLE pixel_bookings IS
  'Attempted and completed pixel purchases. No card data is stored here or anywhere else in this database.';
COMMENT ON COLUMN pixel_bookings.x_range IS
  'Generated half-open pixel span. With y_range, backs the no-overlap exclusion constraint.';


-- The guarantee. Two paid bookings can never share a pixel on the same page:
-- overlapping in one axis is fine, overlapping in both is refused.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pixel_bookings_no_overlap'
  ) THEN
    ALTER TABLE pixel_bookings
      ADD CONSTRAINT pixel_bookings_no_overlap
      EXCLUDE USING gist (
        page_number WITH =,
        x_range WITH &&,
        y_range WITH &&
      )
      WHERE (status = 'paid');
  END IF;
END $$;


CREATE INDEX IF NOT EXISTS pixel_bookings_page_status_idx
  ON pixel_bookings (page_number, status);

CREATE INDEX IF NOT EXISTS pixel_bookings_pending_idx
  ON pixel_bookings (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pixel_bookings_session_idx
  ON pixel_bookings (stripe_session_id);


-- ---------------------------------------------------------------------------
-- advertisements — the creative for a booking.
--
-- Written at the same moment as the pending booking, so nothing the buyer typed
-- is lost when they are redirected to Stripe. UNIQUE on booking_id means a
-- replayed webhook physically cannot produce a second advertisement.
--
-- An advertisement is only ever *rendered* through a join on
-- pixel_bookings.status = 'paid'. An unpaid row is inert.
--
-- WHAT COUNTS AS A USABLE AD
-- --------------------------
-- There are two shapes. An ordinary ad carries a brand name and a headline. A
-- logo-only ad carries neither — it is just an image that links somewhere, for
-- someone who wants to buy a small space for a logo and nothing else. Both always
-- carry a destination_url. The advertisements_content_present constraint below is
-- what allows the second shape without allowing an empty row through.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertisements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL UNIQUE REFERENCES pixel_bookings (id) ON DELETE CASCADE,
  brand_name      TEXT NOT NULL DEFAULT '',
  headline        TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  destination_url TEXT NOT NULL,
  image_url       TEXT NOT NULL DEFAULT '',
  cta_text        TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Either an ordinary ad (brand + headline) or a logo-only ad (an image). An
  -- ad with no text and no image is not something a reader could click or read,
  -- so it is refused here as well as in the application.
  CONSTRAINT advertisements_content_present CHECK (
    (length(btrim(brand_name)) > 0 AND length(btrim(headline)) > 0)
    OR length(btrim(image_url)) > 0
  )
);


-- Bring an already-created advertisements table up to the rule above. CREATE
-- TABLE IF NOT EXISTS never alters an existing table, so a database first built
-- when brand + headline were mandatory keeps its old per-column NOT-EMPTY checks
-- until this runs. Every existing row has both, so adding the combined
-- constraint validates without a rewrite.
DO $$
BEGIN
  -- The inline single-column CHECKs Postgres auto-named when they were mandatory.
  ALTER TABLE advertisements DROP CONSTRAINT IF EXISTS advertisements_brand_name_check;
  ALTER TABLE advertisements DROP CONSTRAINT IF EXISTS advertisements_headline_check;
  -- Empty is now a legitimate stored value for a logo-only ad.
  ALTER TABLE advertisements ALTER COLUMN brand_name SET DEFAULT '';
  ALTER TABLE advertisements ALTER COLUMN headline SET DEFAULT '';
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'advertisements_content_present'
  ) THEN
    ALTER TABLE advertisements
      ADD CONSTRAINT advertisements_content_present CHECK (
        (length(btrim(brand_name)) > 0 AND length(btrim(headline)) > 0)
        OR length(btrim(image_url)) > 0
      );
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- orders — the payment record, written only by the verified webhook.
--
-- UNIQUE on stripe_session_id is the second half of webhook idempotency: even
-- if the same event arrives ten times, only one order row can exist.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id               UUID NOT NULL REFERENCES pixel_bookings (id) ON DELETE CASCADE,
  stripe_session_id        TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  amount                   NUMERIC(12, 2) NOT NULL,
  amount_cents             INTEGER NOT NULL,
  currency                 TEXT NOT NULL DEFAULT 'usd',
  status                   TEXT NOT NULL CHECK (status IN ('paid', 'refunded', 'failed')),
  buyer_email              TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE orders IS
  'Stripe payment records. Stores Stripe identifiers and amounts only - never card numbers, CVCs or expiry dates.';


-- ---------------------------------------------------------------------------
-- webhook_events — every Stripe event id this server has already handled.
--
-- The first line of idempotency. A replayed event fails to insert, and the
-- handler returns 200 without touching anything.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
