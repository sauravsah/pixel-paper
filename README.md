# PIXEL PAPER

A permanent digital newspaper. Nine pages of logical Pixel Units are available
for claim, and each purchased rectangle is recorded exactly once. Choose an
available area, add your identity, pay once, and become part of the paper.

The current runtime uses Supabase Postgres through its server-side connection
pool. The browser never receives database credentials or payment secrets.

## What you need

Four values, and nothing else. Copy `.env.example` to `.env.local` and fill them
in; that file explains where each one comes from.

`DATABASE_URL` points at a Postgres database — a Supabase project is the expected
setup, using the connection string from Connect → ORMs on port 5432. Without it
the site loads and prices rectangles correctly but cannot record a booking.

`DODO_PAYMENTS_API_KEY` and `DODO_PRODUCT_ID` come from the Dodo Payments
dashboard (Developer → API Keys, and a "pay what you want" product). Dodo is the
one and only payment provider. The API key stays on the server and is never sent
to the browser. Every rectangle is a different price, so the newspaper sells
against a single pay-what-you-want product and sets the amount per checkout, in
cents, from the coordinates alone. Without these, checkout cannot start.

`DODO_PAYMENTS_WEBHOOK_KEY` is what makes a payment real. A booking becomes
permanent only when Dodo's signed webhook says the money moved, so without this
value a buyer can pay and never receive their space. Add a webhook endpoint in the
Dodo dashboard, subscribe it to `payment.succeeded` (and `payment.failed`), and
copy its signing secret here.

Dodo talks to **test mode** unless `DODO_PAYMENTS_ENVIRONMENT=live_mode` is set
explicitly, so no real card is ever charged by accident.

## Running it

```bash
npm install
npm run migrate     # creates the runtime tables and the nine pages; safe to re-run
npm run dev         # http://localhost:3000
```

`npm run migrate` is an explicit database step. The server checks database
connectivity on startup but does not run schema changes automatically, so run
the migration before the first start and whenever the schema changes.

The newspaper runs and prices pages with no Dodo credentials at all; checkout is
simply switched off until they are set. To prove the whole payment path locally
without a card, run the end-to-end script (see **Checking it** below) — it signs
its own webhook events. To take a real test-mode purchase through the browser
locally, Dodo needs to reach your machine: expose the dev server with a tunnel
(for example ngrok), set `PUBLIC_BASE_URL` to the tunnel's URL, and register that
same URL's `/api/webhooks/dodo` as a webhook endpoint in the Dodo dashboard. Then
pay with Dodo's test-mode card details (see the Dodo docs); the confirmation
screen waits for the webhook and the space appears on the page.

For a production build, `npm run build` compiles the client into `dist/` and
bundles the server into `build/server.cjs`; `npm start` runs it. Only `dist/`
is exposed as a public static directory; the server bundle and source map stay
outside it.

## Deploy to Render

The repository carries a `render.yaml` Blueprint, so a deploy is mostly clicks.
The one server both builds and serves the site; there is nothing else to stand up.

1. **Push to GitHub.** Render deploys from a repository, so this project needs to
   live in one. `.env.local` and `dist/` are gitignored, so no secret and no build
   artifact is ever pushed.

   ```bash
   git init
   git add -A
   git commit -m "Pixel Paper"
   git branch -M main
   git remote add origin https://github.com/YOU/YOUR-REPO.git
   git push -u origin main
   ```

2. **Create the Blueprint.** In Render: **New → Blueprint**, pick the repository.
   Render reads `render.yaml` and offers one web service. It will ask for the five
   values marked `sync: false` — paste them in (they are never committed):

   - `DATABASE_URL` — the same Supabase pooler string from `.env.local`.
   - `DATABASE_SSL_CA` — the Supabase/provider CA certificate in PEM form.
   - `DODO_PAYMENTS_API_KEY` — your Dodo API key.
   - `DODO_PRODUCT_ID` — the id of your pay-what-you-want product.
   - `DODO_PAYMENTS_WEBHOOK_KEY` — leave a placeholder for now; step 4 replaces it.

   (`DODO_PAYMENTS_ENVIRONMENT` is set to `test_mode` in `render.yaml` itself, so a
   Blueprint deploy never charges real cards by accident.) Run the explicit
   `npm run migrate` step against this database before the first application start.
   For a live deployment, change that environment setting deliberately in the
   deployment configuration and use matching live Dodo credentials.
   Then deploy. When the health
   check at `/api/health` goes green the site is up at
   `https://YOUR-APP.onrender.com`. (On the free plan the instance sleeps when idle
   and cold-starts on the next request — fine for a test deployment.)

3. **The webhook is what makes a purchase stick.** A booking becomes permanent
   only when Dodo's signed webhook arrives, so the live site needs its own webhook
   endpoint pointed at its own URL.

4. **Add the production webhook.** In the Dodo dashboard:
   **Developer → Webhooks → Add endpoint**, pointing at

   ```
   https://YOUR-APP.onrender.com/api/webhooks/dodo
   ```

   Subscribe it to `payment.succeeded` and `payment.failed`. Copy the endpoint's
   **signing secret**, set it as `DODO_PAYMENTS_WEBHOOK_KEY` in the Render
   dashboard, and let the service redeploy.

5. **Buy something.** With Dodo's test-mode card details. The Dodo dashboard shows
   the webhook delivered `200`, the confirmation screen resolves, and the space
   appears on the page for everyone.

Dodo stays in **test mode** throughout; no real card is ever charged. Switching to
live mode is a later, deliberate choice: set `DODO_PAYMENTS_ENVIRONMENT=live_mode`
and use live credentials.

## Checking it

```bash
npm test        # pricing, geometry and validation, no database needed
npm run lint    # tsc --noEmit
npm run test:e2e   # the full purchase path; needs `npm run dev` in another terminal
```

The database-writing end-to-end script is deliberately isolated. It requires
`E2E_BASE_URL`, `E2E_DATABASE_URL`, and `E2E_ALLOW_DATABASE_WRITES=true`, rejects
the production hosts and the configured application database, and optionally
uses `E2E_DATABASE_SSL_CA`. It can confirm bookings via signed synthetic events,
so it must never be pointed at a live deployment. It creates a booking, signs a
fake `payment.succeeded` event with the test webhook key, posts it to the running
server, checks that the pixels became unavailable, and verifies replay behavior.
It also fires two overlapping checkouts at once to confirm only one survives,
and deletes everything it created on the way out.

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

Payment is confirmed in one place: `POST /api/webhooks/dodo`, which verifies the
signature with `DODO_PAYMENTS_WEBHOOK_KEY` before believing anything, records the
event id, and ignores any event it has already processed. The success page Dodo
redirects to can only poll `GET /api/checkout/status` and report what the database
already says. Card details are typed on Dodo's own domain and never reach this
application; no card number is stored anywhere in the schema.

Pending bookings hold their pixels for a few minutes and are then released
automatically, so an abandoned checkout does not take a rectangle out of
circulation.

The current runtime schema has six tables: `newspaper_pages`, `pixel_bookings`,
`advertisements`, `orders`, `webhook_events`, and `visitor_sessions`. Supabase is used as the hosted
Postgres database only for now; Auth, Storage, and the deferred foundation schema
are intentionally outside the production path.

## The shape of the code

`shared/` holds everything both sides must agree on: the pricing config and
engine, the geometry rules that decide what overlaps, and the field rules that
validate a submission. Nothing in there is duplicated on one side, which is why a
quote and a charge cannot drift apart.

`server/` is a small Express application — `routes.ts` for the API, `dodo.ts`
for checkout sessions, `webhook.ts` for confirmation, `repository.ts` for every
query, `visitor.ts` for anonymous reader identity, and `schema.ts` for the tables.
`src/` is the React client, with
`Broadsheet.tsx` turning pages, `NewspaperPage.tsx` handling selection and
rendering, and the rest being chrome.

Rates live in `shared/pricing-config.ts`: the base price per logical Pixel Unit,
the page-tier multipliers, and the minimum purchasable area. Position does not
change price in V1. Change a number there and the price map, sidebar, quote and
charge all move together.

| Endpoint | What it does |
| --- | --- |
| `GET /api/config` | Pricing rules, the price map, and which credentials the server actually has |
| `GET /api/newspaper` | Occupied areas, live advertisements, claimed-pixel totals |
| `POST /api/viewers/heartbeat` | Anonymous live and last-24-hour reader totals |
| `POST /api/quote` | The authoritative price for a rectangle, and whether it is free |
| `POST /api/checkout` | Validates, prices, creates a pending booking, returns a Dodo checkout URL |
| `GET /api/checkout/status` | Reports what the database says about a booking |
| `GET /api/spaces/:id` | One claimed space, for sharing. Paid only, and never the price |
| `POST /api/webhooks/dodo` | The only thing that can mark a booking paid |
