/**
 * THE INTERNET TIMES — END-TO-END ACCEPTANCE TEST
 * ===============================================
 *
 *     npm run dev          # in one terminal
 *     npm run test:e2e     # in another
 *
 * Exercises the real server, the real database, and real Stripe test-mode API
 * calls. It checks the things that would cost money or lose pixels if they were
 * wrong: that prices are computed server-side, that coordinates are validated,
 * that overlapping areas cannot be sold twice, that a browser cannot mark a
 * booking paid, and that a replayed webhook does not duplicate anything.
 *
 * WHY THIS SCRIPT CAN CONFIRM PAYMENTS
 * ------------------------------------
 * To test the webhook path without a human typing a card number, it builds a
 * `checkout.session.completed` payload and signs it with STRIPE_WEBHOOK_SECRET
 * using Stripe's own `generateTestHeaderString`. That is the same verification
 * the live webhook performs, so the test proves the real signature check works —
 * it does not bypass it.
 *
 * Because that capability could otherwise mark bookings paid without payment,
 * the script REFUSES TO RUN unless STRIPE_SECRET_KEY is a test key. It cannot
 * touch a live-mode deployment. It also deletes everything it created on the way
 * out.
 *
 * Nothing in this file is part of the application. The server has no endpoint
 * that does any of this.
 */

import Stripe from 'stripe';

import { PRICING_CONFIG } from '../shared/pricing-config.ts';
import { calculateQuote } from '../shared/pricing.ts';
import { env } from '../server/env.ts';
import { closePool, isDatabaseConfigured, query } from '../server/db.ts';

const BASE = `http://localhost:${env.port}`;

/** Every booking this script creates is tagged so cleanup can find it. */
const TEST_TAG = 'E2E-SELFTEST';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log('');
  console.log(title);
  console.log('-'.repeat(title.length));
}

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json: any = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  return { status: res.status, json };
}

const AD = {
  brandName: TEST_TAG,
  headline: 'Automated acceptance check',
  description: 'Created by npm run test:e2e and removed again at the end.',
  destinationUrl: 'https://example.com',
  ctaText: 'Visit',
  buyerEmail: 'selftest@example.com',
};

/** Find a rectangle on `page` that nothing currently occupies. */
async function findFreeRect(
  page: number,
  width: number,
  height: number
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const { json } = await api('GET', '/api/newspaper');
  const occupied = (json?.occupied ?? []).filter((o: any) => o.pageNumber === page);

  const hits = (x: number, y: number) =>
    occupied.some(
      (o: any) =>
        !(x + width <= o.x || o.x + o.width <= x || y + height <= o.y || o.y + o.height <= y)
    );

  for (let y = 0; y + height <= PRICING_CONFIG.pageHeight; y += 20) {
    for (let x = 0; x + width <= PRICING_CONFIG.pageWidth; x += 20) {
      if (!hits(x, y)) return { x, y, width, height };
    }
  }
  return null;
}

/** Build and sign a synthetic checkout.session.completed event. */
function signedWebhook(sessionId: string, amountCents: number, eventId: string) {
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: 'paid',
        status: 'complete',
        amount_total: amountCents,
        currency: 'usd',
        payment_intent: `pi_selftest_${eventId}`,
        customer_details: { email: AD.buyerEmail },
        customer_email: AD.buyerEmail,
      },
    },
  });

  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: env.stripeWebhookSecret as string,
  });

  return { payload, header };
}

async function postWebhook(payload: string, header: string) {
  const res = await fetch(`${BASE}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  return { status: res.status, text: await res.text() };
}

async function main(): Promise<void> {
  console.log('');
  console.log('THE INTERNET TIMES — acceptance test');
  console.log('===================================');

  // -------------------------------------------------------------------------
  section('Preconditions');

  const health = await api('GET', '/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    console.error('');
    console.error(`  Cannot reach the server at ${BASE}.`);
    console.error('  Start it first:  npm run dev');
    console.error('');
    process.exit(1);
  }
  check('server is running', true);

  if (!isDatabaseConfigured()) {
    console.error('\n  DATABASE_URL is not set. Add it to .env.local.\n');
    process.exit(1);
  }
  check('DATABASE_URL is set', true);

  if (!env.stripeSecretKey) {
    console.error('\n  STRIPE_SECRET_KEY is not set. Add it to .env.local.\n');
    process.exit(1);
  }

  if (!env.stripeSecretKey.startsWith('sk_test_')) {
    console.error('');
    console.error('  REFUSING TO RUN: STRIPE_SECRET_KEY is not a test key.');
    console.error('  This script can confirm bookings via signed synthetic webhooks and');
    console.error('  must never be pointed at a live-mode deployment.');
    console.error('');
    process.exit(1);
  }
  check('Stripe is in test mode', true);

  if (!env.stripeWebhookSecret) {
    console.error('\n  STRIPE_WEBHOOK_SECRET is not set. Add it to .env.local.\n');
    process.exit(1);
  }
  check('STRIPE_WEBHOOK_SECRET is set', true);

  // -------------------------------------------------------------------------
  section('Configuration and secrets');

  const config = await api('GET', '/api/config');
  const configText = JSON.stringify(config.json);

  check('GET /api/config returns 200', config.status === 200);
  check('config exposes the publishable key', typeof config.json.stripePublishableKey === 'string');
  check(
    'config does NOT leak the secret key',
    !configText.includes('sk_test_') && !configText.includes('sk_live_'),
    'a secret key appeared in the config response'
  );
  check(
    'config does NOT leak the webhook secret',
    !configText.includes('whsec_'),
    'the webhook secret appeared in the config response'
  );
  check(
    'config does NOT leak the database URL',
    !configText.includes('postgres'),
    'the database URL appeared in the config response'
  );
  check('there are exactly 6 pages', config.json.pricing?.totalPages === 6);

  const pages = await query<{ n: string }>('SELECT count(*)::text AS n FROM newspaper_pages');
  check('database holds exactly 6 pages', pages[0]?.n === '6', `found ${pages[0]?.n}`);

  // -------------------------------------------------------------------------
  section('Pricing is decided by the server');

  const spot = await findFreeRect(6, 200, 160);
  if (!spot) {
    console.error('\n  No free 200x160 area on page 6 to test with.\n');
    process.exit(1);
  }

  const expected = calculateQuote(PRICING_CONFIG, 6, spot);

  const quote = await api('POST', '/api/quote', { pageNumber: 6, ...spot });
  check('POST /api/quote returns 200', quote.status === 200);
  check(
    'server price matches the shared pricing engine exactly',
    quote.json.quote?.amountCents === expected.amountCents,
    `server ${quote.json.quote?.amountCents} vs engine ${expected.amountCents}`
  );
  check('server reports the area as available', quote.json.available === true);

  const tampered = await api('POST', '/api/quote', {
    pageNumber: 6,
    ...spot,
    price: 0.01,
    amount: 1,
    amountCents: 1,
    totalPrice: 0.01,
    effectiveRate: 0,
  });
  check(
    'a price submitted by the client is ignored',
    tampered.json.quote?.amountCents === expected.amountCents,
    `got ${tampered.json.quote?.amountCents}`
  );

  // -------------------------------------------------------------------------
  section('Coordinates are validated');

  const badGeometry: Array<[string, Record<string, unknown>]> = [
    ['negative x', { pageNumber: 1, x: -10, y: 0, width: 100, height: 100 }],
    ['off the right edge', { pageNumber: 1, x: 950, y: 0, width: 100, height: 100 }],
    ['off the bottom', { pageNumber: 1, x: 0, y: 1350, width: 100, height: 100 }],
    ['wider than the page', { pageNumber: 1, x: 0, y: 0, width: 1001, height: 100 }],
    ['fractional x', { pageNumber: 1, x: 10.5, y: 0, width: 100, height: 100 }],
    ['below the minimum size', { pageNumber: 1, x: 0, y: 0, width: 5, height: 5 }],
    ['page 0', { pageNumber: 0, x: 0, y: 0, width: 100, height: 100 }],
    ['page 7', { pageNumber: 7, x: 0, y: 0, width: 100, height: 100 }],
    ['null coordinate', { pageNumber: 1, x: null, y: 0, width: 100, height: 100 }],
    ['boolean coordinate', { pageNumber: 1, x: true, y: 0, width: 100, height: 100 }],
    ['string coordinate', { pageNumber: 1, x: 'abc', y: 0, width: 100, height: 100 }],
    ['negative width', { pageNumber: 1, x: 100, y: 100, width: -50, height: 50 }],
    ['empty body', {}],
  ];

  for (const [label, payload] of badGeometry) {
    const res = await api('POST', '/api/quote', payload);
    check(`rejects ${label}`, res.status === 400, `got ${res.status}`);
  }

  // -------------------------------------------------------------------------
  section('Advertisement content is validated');

  const badAds: Array<[string, Record<string, unknown>]> = [
    ['a javascript: destination', { ...AD, destinationUrl: 'javascript:alert(1)' }],
    ['a data: destination', { ...AD, destinationUrl: 'data:text/html,<script>x</script>' }],
    // A bounded data:image is a VALID logo attachment (see parseSafeImageSrc), so
    // the rejection cases below are images that are still not allowed: a script
    // dressed as an image, and a real image type that is off the allowlist.
    ['a data:text/html in the image field', { ...AD, imageUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }],
    ['an off-allowlist image type', { ...AD, imageUrl: 'data:image/tiff;base64,SGVsbG8h' }],
    ['a missing brand name', { ...AD, brandName: '' }],
    ['a missing headline', { ...AD, headline: '' }],
    ['a missing destination', { ...AD, destinationUrl: '' }],
  ];

  for (const [label, ad] of badAds) {
    const res = await api('POST', '/api/checkout', { pageNumber: 6, ...spot, ...ad });
    check(`rejects ${label}`, res.status === 400, `got ${res.status}`);
  }

  // -------------------------------------------------------------------------
  section('Checkout creates a pending booking, not a claim');

  const checkout = await api('POST', '/api/checkout', { pageNumber: 6, ...spot, ...AD });
  check('POST /api/checkout returns 200', checkout.status === 200, JSON.stringify(checkout.json));

  const bookingId: string = checkout.json.bookingId;
  const sessionId: string = checkout.json.sessionId;

  check('a booking id came back', typeof bookingId === 'string');
  check('a real Stripe Checkout URL came back', String(checkout.json.checkoutUrl).startsWith('https://'));
  check(
    'the amount Stripe was given is the server amount',
    checkout.json.quote?.amountCents === expected.amountCents
  );

  const afterCheckout = await query<{ status: string }>(
    'SELECT status FROM pixel_bookings WHERE id = $1',
    [bookingId]
  );
  check(
    'the booking is PENDING, not paid',
    afterCheckout[0]?.status === 'pending',
    `status is ${afterCheckout[0]?.status}`
  );

  const paperBefore = await api('GET', '/api/newspaper');
  check(
    'an unpaid booking shows no advertisement to readers',
    !paperBefore.json.ads.some((a: any) => a.bookingId === bookingId)
  );
  check(
    'an unpaid booking does hold its pixels temporarily',
    paperBefore.json.occupied.some(
      (o: any) => o.pageNumber === 6 && o.x === spot.x && o.y === spot.y && o.status === 'pending'
    )
  );

  const statusBefore = await api('GET', `/api/checkout/status?session_id=${sessionId}`);
  check('status endpoint reports pending', statusBefore.json.status === 'pending');
  check('status endpoint withholds the amount until paid', statusBefore.json.booking?.amountPaid === null);

  const spaceBefore = await api('GET', `/api/spaces/${bookingId}`);
  check('an unpaid space is not publicly readable', spaceBefore.status === 404);

  // -------------------------------------------------------------------------
  section('Only a validly signed webhook can confirm payment');

  const unsigned = await fetch(`${BASE}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'checkout.session.completed' }),
  });
  check('a webhook with no signature is refused', unsigned.status === 400, `got ${unsigned.status}`);

  const badSig = await postWebhook(
    JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed', data: { object: {} } }),
    't=1,v1=0000000000000000000000000000000000000000000000000000000000000000'
  );
  check('a webhook with a forged signature is refused', badSig.status === 400, `got ${badSig.status}`);

  const stillPending = await query<{ status: string }>(
    'SELECT status FROM pixel_bookings WHERE id = $1',
    [bookingId]
  );
  check('the forgery attempts changed nothing', stillPending[0]?.status === 'pending');

  const eventId = `evt_selftest_${Date.now()}`;
  const { payload, header } = signedWebhook(sessionId, expected.amountCents, eventId);
  const accepted = await postWebhook(payload, header);
  check('a correctly signed webhook is accepted', accepted.status === 200, accepted.text);

  const afterWebhook = await query<{ status: string; paid_at: string }>(
    'SELECT status, paid_at FROM pixel_bookings WHERE id = $1',
    [bookingId]
  );
  check('the booking is now PAID', afterWebhook[0]?.status === 'paid');
  check('a claim timestamp was recorded', Boolean(afterWebhook[0]?.paid_at));

  const orders = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM orders WHERE booking_id = $1',
    [bookingId]
  );
  check('exactly one order was recorded', orders[0]?.n === '1', `found ${orders[0]?.n}`);

  check(
    'no card data was stored anywhere in the booking row',
    (
      await query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM information_schema.columns
          WHERE table_name IN ('pixel_bookings','orders','advertisements')
            AND (column_name ILIKE '%card%' OR column_name ILIKE '%cvc%'
                 OR column_name ILIKE '%pan%' OR column_name ILIKE '%expiry%')`
      )
    )[0]?.n === '0'
  );

  // -------------------------------------------------------------------------
  section('Webhook replay is idempotent');

  const replay1 = await postWebhook(payload, header);
  const replay2 = await postWebhook(payload, header);
  check('a replayed event is accepted with 200', replay1.status === 200 && replay2.status === 200);

  const counts = await query<Record<string, string>>(
    `SELECT (SELECT count(*)::text FROM advertisements WHERE booking_id = $1) AS ads,
            (SELECT count(*)::text FROM orders WHERE booking_id = $1)         AS orders,
            (SELECT count(*)::text FROM pixel_bookings WHERE id = $1)         AS bookings`,
    [bookingId]
  );
  check('still exactly one advertisement', counts[0]?.ads === '1', `found ${counts[0]?.ads}`);
  check('still exactly one order', counts[0]?.orders === '1', `found ${counts[0]?.orders}`);
  check('still exactly one booking', counts[0]?.bookings === '1');

  // A different event id carrying the same session must also not double up.
  const second = signedWebhook(sessionId, expected.amountCents, `evt_selftest_b_${Date.now()}`);
  await postWebhook(second.payload, second.header);
  const afterSecond = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM orders WHERE booking_id = $1',
    [bookingId]
  );
  check(
    'a new event id for an already-paid session creates no second order',
    afterSecond[0]?.n === '1',
    `found ${afterSecond[0]?.n}`
  );

  // -------------------------------------------------------------------------
  section('The advertisement is now live');

  const paperAfter = await api('GET', '/api/newspaper');
  const liveAd = paperAfter.json.ads.find((a: any) => a.bookingId === bookingId);
  check('the advertisement appears to readers', Boolean(liveAd));
  check('the headline is intact', liveAd?.headline === AD.headline);
  check('the destination URL is intact', liveAd?.destinationUrl?.startsWith('https://example.com'));
  check(
    'the public feed does not disclose what was paid',
    liveAd !== undefined && !('effectivePrice' in liveAd) && !('amountCents' in liveAd)
  );
  check(
    'the area is now permanently claimed',
    paperAfter.json.occupied.some(
      (o: any) => o.pageNumber === 6 && o.x === spot.x && o.y === spot.y && o.status === 'paid'
    )
  );

  const spaceAfter = await api('GET', `/api/spaces/${bookingId}`);
  check('the claimed space is publicly readable', spaceAfter.status === 200);
  check(
    'the shareable space does not disclose the price',
    !JSON.stringify(spaceAfter.json).includes('effectivePrice')
  );

  // -------------------------------------------------------------------------
  section('Claimed pixels cannot be sold twice');

  const overlaps: Array<[string, { x: number; y: number; width: number; height: number }]> = [
    ['an identical rectangle', { ...spot }],
    ['a rectangle overlapping one corner', { x: spot.x + spot.width - 20, y: spot.y + spot.height - 20, width: 120, height: 120 }],
    ['a rectangle fully containing it', { x: Math.max(0, spot.x - 40), y: Math.max(0, spot.y - 40), width: spot.width + 80, height: spot.height + 80 }],
    ['a rectangle fully inside it', { x: spot.x + 40, y: spot.y + 40, width: 60, height: 60 }],
  ];

  for (const [label, rect] of overlaps) {
    const res = await api('POST', '/api/checkout', { pageNumber: 6, ...rect, ...AD });
    check(`refuses ${label}`, res.status === 409, `got ${res.status}`);

    const q = await api('POST', '/api/quote', { pageNumber: 6, ...rect });
    check(`quote reports ${label} as unavailable`, q.json.available === false);
  }

  const sameRectOtherPage = await api('POST', '/api/quote', { pageNumber: 5, ...spot });
  check(
    'the same rectangle on a different page is still free',
    sameRectOtherPage.json.available === true
  );

  // The database itself must refuse an overlap even without the app's help.
  let constraintHeld = false;
  try {
    await query(
      `INSERT INTO pixel_bookings
         (page_number, x, y, width, height, pixel_count, price_per_pixel,
          effective_price, amount_cents, page_multiplier, position_multiplier, status)
       VALUES (6, $1, $2, $3, $4, $5, 0.0001, 1.00, 100, 0.9, 1.0, 'paid')`,
      [spot.x, spot.y, spot.width, spot.height, spot.width * spot.height]
    );
  } catch (err: any) {
    constraintHeld = err.code === '23P01';
  }
  check(
    'the database refuses an overlapping paid row directly',
    constraintHeld,
    'the exclusion constraint did not fire'
  );

  // -------------------------------------------------------------------------
  section('Two buyers reaching for the same pixels at once');

  // The sequential checks above pass even without a lock, because the first
  // booking is already committed by the time the second is attempted. This is the
  // one that needs the lock: both requests are in flight together, so without
  // serialisation both would see free pixels and both would be sold the same
  // rectangle. Page 5 is used so it cannot interfere with the page 6 fixtures.
  const raceSpot = await findFreeRect(5, 180, 140);

  if (!raceSpot) {
    console.log('  skip  concurrency test (no free 180x140 area on page 5)');
  } else {
    // Inset rather than offset, so the second rectangle is guaranteed both to
    // overlap the first and to still be on the page wherever findFreeRect
    // happened to land. 140 x 100 clears the 40 x 40 minimum.
    const overlapping = {
      x: raceSpot.x + 20,
      y: raceSpot.y + 20,
      width: raceSpot.width - 40,
      height: raceSpot.height - 40,
    };

    const [first, second] = await Promise.all([
      api('POST', '/api/checkout', { pageNumber: 5, ...raceSpot, ...AD }),
      api('POST', '/api/checkout', { pageNumber: 5, ...overlapping, ...AD }),
    ]);

    const codes = [first.status, second.status].sort();
    check(
      'exactly one of two simultaneous overlapping checkouts succeeds',
      codes[0] === 200 && codes[1] === 409,
      `got ${first.status} and ${second.status}`
    );

    const held = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pixel_bookings
        WHERE page_number = 5 AND status = 'pending'
          AND x_range && int4range($1, $2) AND y_range && int4range($3, $4)`,
      [
        raceSpot.x,
        raceSpot.x + raceSpot.width,
        raceSpot.y,
        raceSpot.y + raceSpot.height,
      ]
    );
    check(
      'only one pending hold exists over the contested pixels',
      held[0]?.n === '1',
      `found ${held[0]?.n}`
    );

    // Whichever won is released again, so this section leaves nothing behind for
    // the sections after it.
    for (const res of [first, second]) {
      if (res.status === 200 && res.json?.bookingId) {
        await query(`DELETE FROM pixel_bookings WHERE id = $1`, [res.json.bookingId]);
      }
    }
  }

  // -------------------------------------------------------------------------
  section('Edge-adjacent areas and repeat buyers');

  const flush = {
    x: spot.x + spot.width,
    y: spot.y,
    width: 60,
    height: spot.height,
  };

  if (flush.x + flush.width <= PRICING_CONFIG.pageWidth) {
    const flushQuote = await api('POST', '/api/quote', { pageNumber: 6, ...flush });
    check(
      'a rectangle flush against a claimed edge is available',
      flushQuote.json.available === true,
      'edge-adjacent areas must not be treated as overlapping'
    );

    const secondBuy = await api('POST', '/api/checkout', { pageNumber: 6, ...flush, ...AD });
    check(
      'the same buyer can purchase again',
      secondBuy.status === 200,
      `got ${secondBuy.status}: ${JSON.stringify(secondBuy.json)}`
    );

    if (secondBuy.status === 200) {
      const evt = signedWebhook(
        secondBuy.json.sessionId,
        secondBuy.json.quote.amountCents,
        `evt_selftest_c_${Date.now()}`
      );
      await postWebhook(evt.payload, evt.header);

      const both = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pixel_bookings
          WHERE status = 'paid' AND page_number = 6 AND buyer_email = $1`,
        [AD.buyerEmail]
      );
      check(
        'both purchases by the same buyer are claimed',
        Number(both[0]?.n) >= 2,
        `found ${both[0]?.n}`
      );
    }
  } else {
    console.log('  skip  edge-adjacent test (no room to the right of the test area)');
  }

  // -------------------------------------------------------------------------
  section('Cleanup');

  const removed = await query<{ id: string }>(
    `DELETE FROM pixel_bookings
      WHERE id IN (SELECT booking_id FROM advertisements WHERE brand_name = $1)
      RETURNING id`,
    [TEST_TAG]
  );
  check(`removed ${removed.length} test booking(s)`, true);

  const leftover = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM advertisements WHERE brand_name = $1`,
    [TEST_TAG]
  );
  check('no test data left behind', leftover[0]?.n === '0', `${leftover[0]?.n} remaining`);

  // The synthetic event ids are also something this script created. Leaving them
  // would be harmless, but the header above promises everything goes.
  const events = await query<{ id: string }>(
    `DELETE FROM webhook_events WHERE id LIKE 'evt_selftest%' RETURNING id`
  );
  check(`removed ${events.length} test webhook event(s)`, true);

  // -------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(52));
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('='.repeat(52));

  if (failed > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    console.log('');
    process.exitCode = 1;
  } else {
    console.log('');
    console.log('  Everything checks out.');
    console.log('');
  }
}

main()
  .catch((err) => {
    console.error('');
    console.error('The acceptance test crashed:', err);
    console.error('');
    process.exitCode = 1;
  })
  .finally(closePool);
