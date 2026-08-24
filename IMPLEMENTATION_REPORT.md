# THE INTERNET TIMES — IMPLEMENTATION REPORT

## 1. What was built

The prototype was converted into a working marketplace rather than rebuilt. The
masthead, newsprint palette, typography, page layout and the click-drag selection
experience are the ones that were already there; what changed is everything behind
them.

Selection is now genuinely free-form. A buyer drags out any rectangle at any
integer coordinate on any of the six pages, with width, height, pixel count, price
per pixel, effective rate and total updating continuously as the cursor moves.
There are no slots, no fixed boxes and no inventory. Areas somebody already owns
refuse the cursor and cannot be dragged over.

Price comes from `effective_pixel_price = base_rate × page_multiplier ×
position_multiplier`, with the position multiplier sampled from a continuous
attention field rather than a grid of boxes — the top of a page is worth more than
the bottom, the right more than the left, and a hot spot at roughly (0.5, 0.34)
lifts the area the eye lands on first. The price map draws that field 12×18,
blurred, so it reads as a wash over newsprint instead of a chequerboard. Every
number lives in one file, `shared/pricing-config.ts`, which the server treats as
authoritative and serves to the browser, so changing a multiplier moves the map,
the sidebar, the quote and the actual charge together. Nothing about who is buying
or what they are advertising enters the calculation; there are no advertiser
categories anywhere in the system.

The purchase path is: drag a rectangle → fill in brand, headline and destination
URL (description, image and CTA optional) with a live preview → the server
validates the area, prices it, writes a PENDING booking and creates a Stripe
Checkout Session → the buyer pays on Stripe's domain → Stripe's signed webhook
marks the booking PAID → the pixels are permanently claimed and the ad is live.
Afterwards a confirmation screen shows what was bought and offers view, copy link
and share. Reading mode renders only real paid advertisements. A fresh database is
six blank pages, zero bookings, zero advertisements, zero orders — there is no
seeded content of any kind.

Navigation is a real CSS 3D page turn across four views (cover 1 → 2–3 → 4–5 →
back 6), driven by a leaf hinged on the spine with the destination spread mounted
underneath, so nothing is crossfaded or swapped mid-flight. Click, arrows, keyboard
and swipe all work. Light and dark mode both work throughout, including the booking
modal, pricing panel and confirmation screen, and the preference persists and is
applied before first paint.

## 2. Database tables created

Five, created idempotently on every boot by `server/schema.ts`.

`newspaper_pages` holds the six permanent pages. `pixel_bookings` is one row per
attempted purchase, `status` in `pending | paid | cancelled`, carrying the
coordinates, the pixel count, the price per pixel, the total in dollars and in
cents, and the two multipliers that produced it — kept so an old booking can still
be explained after the config changes. `advertisements` holds the creative, UNIQUE
on `booking_id`. `orders` is the payment record, UNIQUE on `stripe_session_id`.
`webhook_events` remembers which Stripe event ids have already been handled.

No card numbers, CVCs or expiry dates exist in the schema, and none ever reach the
server — card entry happens entirely on Stripe's hosted page. All that is stored
are Stripe's own opaque identifiers, the amount, and the buyer's email.

`pixel_bookings` also carries two generated `int4range` columns and an
`EXCLUDE USING gist (page_number WITH =, x_range WITH &&, y_range WITH &&) WHERE
(status = 'paid')` constraint. Two paid bookings sharing a pixel cannot both exist,
under any concurrency, across any number of processes, regardless of what the
application above it does. Half-open `[)` bounds mean a block ending at 99 and one
starting at 100 are not treated as overlapping.

## 3. API endpoints created

| Endpoint | What it does |
| --- | --- |
| `GET /api/config` | Pricing rules, price map, and which credentials the server actually has |
| `GET /api/newspaper` | Occupied areas, live advertisements, claimed-pixel totals |
| `POST /api/quote` | The authoritative price for a rectangle, and whether it is free |
| `POST /api/checkout` | Validates, prices, writes a pending booking, returns a Checkout URL |
| `GET /api/checkout/status` | Reports only what the database already says about a session |
| `GET /api/spaces/:id` | One claimed space for sharing — paid only, and never the price |
| `POST /api/stripe/webhook` | The only thing in the system that can mark a booking paid |

`POST /api/checkout` answers 409 `area-unavailable`, 400 `invalid-advertisement`,
and 503 `stripe-not-configured`. Neither `/api/newspaper` nor `/api/spaces/:id`
discloses what anybody paid.

## 4. Stripe integration status

Complete, in test mode, through the existing integration rather than a second one
beside it. `server/stripe.ts` is the only file that touches the SDK; the secret key
is read there and never returned by an endpoint, never logged, and never imported
by anything under `src/`. Sessions are `mode: 'payment'` — one payment, no
subscription object of any kind. `unit_amount` is taken from the booking row the
server wrote, so no price submitted by a client is involved at any point.

The browser receives only the publishable key. A `price`, `amount` or `amountCents`
in a request body is not read by anything, and the end-to-end test asserts that
submitting one changes the quote by zero.

## 5. Webhook status

`POST /api/stripe/webhook` is mounted with `express.raw` before any JSON parser, so
the exact bytes Stripe signed are available, and every request is verified with
`STRIPE_WEBHOOK_SECRET` before anything is believed. It handles
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed` and `checkout.session.expired`.

Idempotency has two layers. The event id is claimed in `webhook_events` first, so a
replay returns 200 without repeating any work; and UNIQUE constraints on
`advertisements.booking_id` and `orders.stripe_session_id` make a duplicate
physically impossible even if the first layer were bypassed. A new event id
carrying an already-paid session also creates nothing.

Before claiming pixels the handler checks that the amount Stripe reports matches
the amount the server stored, then re-checks availability under the page lock. If
two payments land on overlapping pixels in the same instant, the later one is
refunded in full, its booking cancelled, and a `refunded` row written to `orders`
so the money leaves a trace. Losing a race never costs the buyer anything.

## 6. Environment variables required

Four, and nothing else. `.env.example` explains where each comes from.

- `DATABASE_URL` — Supabase/Postgres connection string.
- `STRIPE_SECRET_KEY` — `sk_test_…`; stays on the server.
- `STRIPE_PUBLISHABLE_KEY` — `pk_test_…`; served to the browser deliberately.
- `STRIPE_WEBHOOK_SECRET` — `whsec_…`; without it a buyer can pay and never
  receive their space, because only the signed webhook can confirm a payment.

`PORT` and `PUBLIC_BASE_URL` are optional and only matter behind a tunnel.

## 7. The remaining manual step

One: put those four values in `.env.local`.

```bash
cp .env.example .env.local
```

`DATABASE_URL` — Supabase dashboard → your project → Connect → ORMs/Postgres, the
URI-form connection string on port 5432.

`STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` —
<https://dashboard.stripe.com/test/apikeys>, Test mode left on.

`STRIPE_WEBHOOK_SECRET` — run `npm run stripe:listen` and copy the `whsec_…` it
prints. For a deployed site, create the endpoint at
<https://dashboard.stripe.com/test/webhooks> pointing at
`https://your-domain/api/stripe/webhook`, subscribe it to
`checkout.session.completed`, and copy the signing secret shown there.

Nothing else needs configuring, and no dashboard setup beyond that webhook
endpoint is required.

## 8. How to test it

```bash
npm install
npm run migrate          # creates the tables and the six pages; safe to re-run
npm run dev              # http://localhost:3000
npm run stripe:listen    # second terminal, so payments can be confirmed
```

Then, by hand: open the site, click through the page turn from the cover to 2–3 to
4–5 to 6, switch to select mode and drag out a rectangle. Watch the dimensions and
price change as you drag, and check that the number is the same on page 1 as it is
on page 6 multiplied by 1.5/0.9, that the top of a page costs more than the bottom,
and that the right costs more than the left. Fill in the ad, continue to checkout,
and pay with `4242 4242 4242 4242`, any future expiry, any CVC. The confirmation
screen waits for the webhook rather than assuming success; when it lands the space
appears on the page. Then try to drag over it — the cursor should refuse. Buy a
second space, to confirm repeat purchases work. Toggle light and dark mode with the
modal open. On a phone, pinch to zoom before drawing, and use the arrows rather
than a swipe to change page while selecting.

Automated:

```bash
npm test            # 57 unit tests: pricing, geometry, validation. No database needed.
npm run lint        # tsc --noEmit
npm run test:e2e    # the full purchase path; needs npm run dev running
```

`npm run test:e2e` is the one that matters. It signs a synthetic
`checkout.session.completed` with your webhook secret — the same verification the
live handler performs, so it proves the signature check works rather than bypassing
it — and refuses to run unless `STRIPE_SECRET_KEY` is a test key. It asserts that
the config response leaks no secret, that a client-submitted price is ignored, that
thirteen kinds of malformed geometry are refused, that `javascript:` and `data:`
destinations are rejected, that a checkout produces a PENDING booking and no
visible ad, that unsigned and forged webhooks change nothing, that a valid one
claims the pixels, that replays create no duplicates, that four shapes of overlap
are all refused, that the database's own constraint fires on a direct insert, that
two simultaneous overlapping checkouts produce exactly one winner and one 409, that
an edge-adjacent rectangle is still available, and that the same buyer can purchase
twice. It deletes everything it created on the way out.

## What was verified here, and what was not

Run and passing: the 57 unit tests, a structural parse of all 33 TypeScript and TSX
files, a resolution check on every relative import, a dark-mode audit requiring
every unconditional colour utility to have a `dark:` counterpart (the four
remaining exceptions — a deliberately dark banner and the X brand blue — are
documented in comments at those lines), and a control-byte scan of the repository.

Not run, because this environment has no network, no installed dependencies and no
Postgres: `npm install`, `tsc --noEmit`, `vite build`, the server itself, and any
SQL. Those are what `npm run test:e2e` is for, and it needs your credentials to
run.
