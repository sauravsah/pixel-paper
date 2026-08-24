# THE INTERNET TIMES

A permanent newspaper made of pixels. Six pages, and every pixel on them is for
sale exactly once. Choose any available rectangle, write what should go in it, pay
once, and it is yours — no subscription, no renewal, no expiry, and no edition
tomorrow that replaces this one.

There is no seeded content. A fresh database means six blank pages, and anything
you see on them was bought by somebody.

## What you need

Four values, and nothing else. Copy `.env.example` to `.env.local` and fill them
in; that file explains where each one comes from.

`DATABASE_URL` points at a Postgres database — a Supabase project is the expected
setup, using the connection string from Connect → ORMs on port 5432. Without it
the site loads and prices rectangles correctly but cannot record a booking.

`STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` come from
<https://dashboard.stripe.com/test/apikeys> with Test mode left switched on. The
secret key stays on the server and is never sent to the browser. Without them
checkout cannot start.

`STRIPE_WEBHOOK_SECRET` is what makes a payment real. A booking becomes permanent
only when Stripe's signed webhook says the money moved, so without this value a
buyer can pay and never receive their space. For local development, run
`npm run stripe:listen` and copy the `whsec_…` value it prints.

## Running it

```bash
npm install
npm run migrate     # creates the tables and the six pages; safe to re-run
npm run dev         # http://localhost:3000
```

In a second terminal, so payments can be confirmed:

```bash
npm run stripe:listen
```

Then buy something with Stripe's test card `4242 4242 4242 4242`, any future
expiry, any CVC. The purchase completes, the confirmation screen waits for the
webhook, and the space appears on the page.

For a production build, `npm run build` compiles the client into `dist/` and
bundles the server into `dist/server.cjs`; `npm start` runs it.

## Deploy to Render

The repository carries a `render.yaml` Blueprint, so a deploy is mostly clicks.
The one server both builds and serves the site; there is nothing else to stand up.

1. **Push to GitHub.** Render deploys from a repository, so this project needs to
   live in one. `.env.local` and `dist/` are gitignored, so no secret and no build
   artifact is ever pushed.

   ```bash
   git init
   git add -A
   git commit -m "The Internet Times"
   git branch -M main
   git remote add origin https://github.com/YOU/YOUR-REPO.git
   git push -u origin main
   ```

2. **Create the Blueprint.** In Render: **New → Blueprint**, pick the repository.
   Render reads `render.yaml` and offers one web service. It will ask for the four
   values marked `sync: false` — paste them in (they are never committed):

   - `DATABASE_URL` — the same Supabase pooler string from `.env.local`.
   - `STRIPE_SECRET_KEY` — your `sk_test_…` key.
   - `STRIPE_PUBLISHABLE_KEY` — your `pk_test_…` key.
   - `STRIPE_WEBHOOK_SECRET` — leave a placeholder for now; step 4 replaces it.

   Deploy. When the health check at `/api/health` goes green the site is up at
   `https://YOUR-APP.onrender.com`. (On the free plan the instance sleeps when
   idle and cold-starts on the next request — fine for a test deployment.)

3. **The webhook is what makes a purchase stick.** A booking becomes permanent
   only when Stripe's signed webhook arrives, and the secret the Stripe CLI prints
   for local use does **not** work for the deployed site. The live site needs its
   own endpoint.

4. **Add the production webhook.** In the Stripe dashboard (Test mode on):
   **Developers → Webhooks → Add endpoint**, pointing at

   ```
   https://YOUR-APP.onrender.com/api/stripe/webhook
   ```

   Subscribe to `checkout.session.completed` (and, to match the handler exactly,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   and `checkout.session.expired`). Copy the endpoint's **Signing secret**
   (`whsec_…`), set it as `STRIPE_WEBHOOK_SECRET` in the Render dashboard, and let
   the service redeploy.

5. **Buy something.** With Stripe's test card `4242 4242 4242 4242`, any future
   expiry, any CVC. The Stripe dashboard shows the webhook delivered `200`, the
   confirmation screen resolves, and the space appears on the page for everyone.

Stripe stays in **test mode** throughout; no real card is ever charged. Switching
to live keys is a later, deliberate choice made in the dashboard.

## Checking it

```bash
npm test        # pricing, geometry and validation, no database needed
npm run lint    # tsc --noEmit
npm run test:e2e   # the full purchase path; needs `npm run dev` in another terminal
```

The end-to-end script needs all four values, and refuses to run unless
`STRIPE_SECRET_KEY` is a test key — it can confirm bookings via signed synthetic
events, so it must never be pointed at a live deployment. It creates a booking,
signs a fake `checkout.session.completed` event with your webhook secret, posts it
to the running server, and checks that the pixels became unavailable and that
replaying the same event a second time changes nothing. It also fires two
overlapping checkouts at once to confirm only one survives, and deletes everything
it created on the way out.

## How the money and the pixels line up

The rule the whole design serves: the browser is never allowed to decide that
something has been paid for, or that an area is free.

Prices are computed in `shared/pricing.ts`, which both the server and the browser
import. While you drag, the client runs it locally so the number keeps up with the
cursor. On release it asks `POST /api/quote` and replaces its own answer with the
server's. At checkout the server prices the rectangle again from the coordinates
alone; a `price` or `amount` in the request body is ignored, because nothing reads
it.

Availability works the same way. `pixel_bookings` carries `int4range` columns for
the horizontal and vertical extent of every booking and an `EXCLUDE USING gist`
constraint across them, so two overlapping live bookings on the same page cannot
exist even if every check above the database failed. A checkout takes a
transaction-scoped advisory lock on the page, re-checks the area, and inserts;
concurrent attempts on the same rectangle serialise, and the loser is refunded
rather than left holding a charge for pixels it does not own.

Payment is confirmed in one place: `POST /api/stripe/webhook`, which verifies the
signature with `STRIPE_WEBHOOK_SECRET` before believing anything, records the
event id, and ignores any event it has already processed. The success page Stripe
redirects to can only poll `GET /api/checkout/status` and report what the database
already says. Card details are typed on Stripe's own domain and never reach this
application; no card number is stored anywhere in the schema.

Pending bookings hold their pixels for a few minutes and are then released
automatically, so an abandoned checkout does not take a rectangle out of
circulation.

There are five tables. Four hold the newspaper — `newspaper_pages`,
`pixel_bookings`, `advertisements`, `orders` — and the fifth, `webhook_events`,
exists only to remember which Stripe event ids have already been handled, which is
what makes a replayed webhook a no-op instead of a second sale.

## The shape of the code

`shared/` holds everything both sides must agree on: the pricing config and
engine, the geometry rules that decide what overlaps, and the field rules that
validate a submission. Nothing in there is duplicated on one side, which is why a
quote and a charge cannot drift apart.

`server/` is a small Express application — `routes.ts` for the API, `stripe.ts`
for sessions, `webhook.ts` for confirmation, `repository.ts` for every query, and
`schema.ts` for the tables. `src/` is the React client, with `Broadsheet.tsx`
turning pages, `NewspaperPage.tsx` handling selection and rendering, and the rest
being chrome.

Rates live in `shared/pricing-config.ts`: the base per-pixel price, the six page
multipliers, the shape of the position field that makes the top and right of a
page cost more than the bottom and left, and the minimum purchasable size. Change
a number there and the price map, the sidebar, the quote and the charge all move
together. Nothing about a buyer or what they are advertising enters the
calculation.

| Endpoint | What it does |
| --- | --- |
| `GET /api/config` | Pricing rules, the price map, and which credentials the server actually has |
| `GET /api/newspaper` | Occupied areas, live advertisements, claimed-pixel totals |
| `POST /api/quote` | The authoritative price for a rectangle, and whether it is free |
| `POST /api/checkout` | Validates, prices, creates a pending booking, returns a Stripe Checkout URL |
| `GET /api/checkout/status` | Reports what the database says about a session |
| `GET /api/spaces/:id` | One claimed space, for sharing. Paid only, and never the price |
| `POST /api/stripe/webhook` | The only thing that can mark a booking paid |
