/**
 * Pure-logic tests for Pixel Paper pricing and inventory geometry.
 *
 * Pixel Units are logical newspaper inventory units. They do not change with
 * viewport size, and V1 pricing ignores exact visual position.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  hasValidFullDiscountEvidence,
  hasVerifiedFullDiscountEvidence,
  isProviderAmountAcceptable,
  paymentAmountsForOrder,
  TransientProviderLookupError,
} from '../server/payment-validation.ts';
import {
  refundPaymentIfNeeded,
  type RefundPaymentSnapshot,
  type RefundProvider,
} from '../server/dodo.ts';
import { claimWebhookEvent, type RefundRecord } from '../server/repository.ts';
import {
  processClaimedWebhook,
  processConflictRefund,
} from '../server/webhook.ts';

import { PRICING_CONFIG as CFG } from '../shared/pricing-config.ts';
import {
  averagePositionMultiplier,
  buildPriceMap,
  calculateQuote,
  positionLabel,
  positionMultiplierAtPoint,
  tierForMultiplier,
} from '../shared/pricing.ts';
import {
  clampAgainstOccupied,
  inventoryRect,
  inventoryTopForPage,
  pointInRect,
  rectInInventory,
  rectsOverlap,
  validateSelection,
} from '../shared/geometry.ts';

const PAYMENT_EVENT_TIME = Date.parse('2026-01-01T00:00:00.000Z');

const quoteAt = (page: number, x: number, y: number, w = 20, h = 20) =>
  calculateQuote(CFG, page, { x, y, width: w, height: h });

const inventoryQuoteAt = (page: number, x: number, y: number, w: number, h: number) =>
  calculateQuote(CFG, page, { x, y, width: w, height: h });

test('initial newspaper structure exposes front page plus four spreads', () => {
  assert.equal(CFG.totalPages, 9);
  assert.deepEqual(CFG.pageMultipliers, {
    1: 5,
    2: 2.5,
    3: 2.5,
    4: 1.75,
    5: 1.75,
    6: 1.25,
    7: 1.25,
    8: 1,
    9: 1,
  });
});

test('base rate is one cent per logical Pixel Unit', () => {
  assert.equal(CFG.baseRate, 0.01);
});

test('same rectangle costs the same anywhere on the same page', () => {
  const topLeft = quoteAt(2, 0, 0, 20, 20);
  const bottomRight = quoteAt(2, 80, 120, 20, 20);
  assert.equal(topLeft.amountCents, bottomRight.amountCents);
  assert.equal(topLeft.positionMultiplier, 1);
  assert.equal(bottomRight.positionMultiplier, 1);
});

test('page and spread multipliers determine V1 price', () => {
  const front = quoteAt(1, 10, 10, 20, 20);
  const highLeft = quoteAt(2, 10, 10, 20, 20);
  const highRight = quoteAt(3, 10, 10, 20, 20);
  const base = quoteAt(9, 10, 10, 20, 20);

  assert.ok(front.amountCents > highLeft.amountCents);
  assert.equal(highLeft.amountCents, highRight.amountCents);
  assert.ok(highRight.amountCents > base.amountCents);
});

test('effective rate is base x page multiplier x neutral position multiplier', () => {
  const q = quoteAt(4, 30, 20, 25, 12);
  const expectedRate = Math.round(CFG.baseRate * CFG.pageMultipliers[4] * 1e10) / 1e10;

  assert.equal(q.pixelCount, 25 * 12);
  assert.equal(q.positionMultiplier, 1);
  assert.equal(q.effectiveRate, expectedRate);
  assert.equal(q.amountCents, Math.max(CFG.minChargeCents, Math.round(q.pixelCount * q.effectiveRate * 100)));
});

test('amounts are always whole cents and total price is derived from them', () => {
  const quotes = [
    inventoryQuoteAt(1, 0, CFG.inventoryTop, 2, 2),
    inventoryQuoteAt(4, 10, inventoryTopForPage(CFG, 4) + 1, 7, 11),
    inventoryQuoteAt(9, 30, CFG.inventoryBottom - 20, 20, 20),
    inventoryQuoteAt(2, 0, inventoryTopForPage(CFG, 2), CFG.pageWidth, CFG.inventoryBottom - inventoryTopForPage(CFG, 2)),
  ];

  for (const quote of quotes) {
    assert.equal(Number.isInteger(quote.amountCents), true);
    assert.equal(quote.totalPrice, quote.amountCents / 100);
  }
});

test('repeating the same quote calculation is deterministic', () => {
  const expected = inventoryQuoteAt(4, 23, inventoryTopForPage(CFG, 4) + 9, 17, 13);

  for (let attempt = 0; attempt < 25; attempt++) {
    assert.deepEqual(inventoryQuoteAt(4, 23, inventoryTopForPage(CFG, 4) + 9, 17, 13), expected);
  }
});

test('price increases with area within one page tier', () => {
  const smaller = inventoryQuoteAt(8, 10, inventoryTopForPage(CFG, 8) + 2, 10, 10);
  const larger = inventoryQuoteAt(8, 10, inventoryTopForPage(CFG, 8) + 2, 20, 20);

  assert.equal(smaller.pageMultiplier, larger.pageMultiplier);
  assert.ok(larger.pixelCount > smaller.pixelCount);
  assert.ok(larger.amountCents > smaller.amountCents);
});

test('maximum charge clamps a quote when a test configuration ceiling is exceeded', () => {
  const cappedConfig = { ...CFG, maxChargeCents: 1_234 };
  const quote = calculateQuote(cappedConfig, 1, {
    x: 0,
    y: CFG.inventoryTop,
    width: CFG.pageWidth,
    height: 100,
  });

  assert.ok(quote.pixelCount * quote.effectiveRate * 100 > cappedConfig.maxChargeCents);
  assert.equal(quote.amountCents, cappedConfig.maxChargeCents);
  assert.equal(quote.minimumApplied, false);
  assert.equal(quote.totalPrice, 12.34);
});

test('minimum charge and maximum charge are enforced', () => {
  const tiny = quoteAt(9, 0, 0, CFG.minSelectionWidth, CFG.minSelectionHeight);
  assert.equal(tiny.amountCents, CFG.minChargeCents);
  assert.equal(tiny.minimumApplied, true);

  const whole = quoteAt(1, 0, 0, CFG.pageWidth, CFG.pageHeight);
  assert.ok(whole.amountCents <= CFG.maxChargeCents);
});

test('position helpers are neutral compatibility shims in V1', () => {
  assert.equal(positionMultiplierAtPoint(CFG, 0, 0), 1);
  assert.equal(positionMultiplierAtPoint(CFG, 1, 1), 1);
  assert.equal(averagePositionMultiplier(CFG, { x: 0, y: 0, width: 20, height: 20 }), 1);
  assert.equal(positionLabel(CFG, { x: 80, y: 120, width: 20, height: 20 }), 'Page tier');
});

test('tiers are ordered by page multiplier', () => {
  assert.equal(tierForMultiplier(CFG, 5), 'premium');
  assert.equal(tierForMultiplier(CFG, 2.5), 'high');
  assert.equal(tierForMultiplier(CFG, 1.25), 'medium');
  assert.equal(tierForMultiplier(CFG, 1), 'standard');
});

test('price map remains a neutral overlay and tiles the page exactly once', () => {
  const cells = buildPriceMap(CFG, 12, 18);
  assert.equal(cells.length, 12 * 18);
  assert.equal(new Set(cells.map((cell) => cell.multiplier)).size, 1);
  const area = cells.reduce((sum, cell) => sum + cell.w * cell.h, 0);
  assert.ok(Math.abs(area - 1) < 1e-9);
});

test('overlapping rectangles are detected', () => {
  const a = { x: 10, y: 10, width: 10, height: 10 };
  assert.ok(rectsOverlap(a, { x: 15, y: 15, width: 5, height: 5 }));
  assert.ok(rectsOverlap(a, { x: 19, y: 19, width: 4, height: 4 }));
});

test('rectangles that only touch edges do not overlap', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(rectsOverlap(a, { x: 10, y: 0, width: 10, height: 10 }), false);
  assert.equal(rectsOverlap(a, { x: 0, y: 10, width: 10, height: 10 }), false);
});

test('overlap detection is symmetric', () => {
  const pairs = [
    [{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }],
    [{ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 10, width: 10, height: 10 }],
    [{ x: 3, y: 9, width: 40, height: 4 }, { x: 0, y: 0, width: 100, height: 140 }],
  ] as const;

  for (const [a, b] of pairs) {
    assert.equal(rectsOverlap(a, b), rectsOverlap(b, a));
  }
});

test('contained rectangles overlap in either direction', () => {
  const outer = { x: 10, y: 10, width: 40, height: 40 };
  const inner = { x: 20, y: 20, width: 5, height: 5 };

  assert.equal(rectsOverlap(outer, inner), true);
  assert.equal(rectsOverlap(inner, outer), true);
});

test('diagonal corner touch does not overlap, but a one-pixel corner does', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };

  assert.equal(rectsOverlap(a, { x: 10, y: 10, width: 10, height: 10 }), false);
  assert.equal(rectsOverlap(a, { x: 9, y: 9, width: 1, height: 1 }), true);
});

test('point containment uses the same half-open rule', () => {
  const r = { x: 10, y: 10, width: 10, height: 10 };
  assert.ok(pointInRect(r, 10, 10));
  assert.ok(pointInRect(r, 19, 19));
  assert.equal(pointInRect(r, 20, 19), false);
});

test('a well formed inventory selection validates', () => {
  const r = validateSelection(CFG, 2, 10, inventoryTopForPage(CFG, 2), 30, 40);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rect, { x: 10, y: inventoryTopForPage(CFG, 2), width: 30, height: 40 });
});

test('bad pages are rejected and pages 1..9 are accepted', () => {
  for (const page of [0, 10, -1, 1.5, 'two', null, undefined, NaN, Infinity, true, false, [], {}, '']) {
    assert.equal(validateSelection(CFG, page, 0, CFG.inventoryTop, 10, 10).ok, false, `page ${String(page)}`);
  }
  for (let page = 1; page <= CFG.totalPages; page++) {
    assert.equal(validateSelection(CFG, page, 0, inventoryTopForPage(CFG, page), 10, 10).ok, true, `page ${page}`);
  }
});

test('numeric strings from a form post are accepted', () => {
  const r = validateSelection(CFG, '3', '10', String(inventoryTopForPage(CFG, 3)), '30', '40');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rect, { x: 10, y: inventoryTopForPage(CFG, 3), width: 30, height: 40 });
});

test('coordinates outside the logical page are rejected', () => {
  assert.equal(validateSelection(CFG, 1, -1, 0, 10, 10).error, 'out-of-bounds');
  assert.equal(validateSelection(CFG, 1, 0, -1, 10, 10).error, 'out-of-bounds');
  assert.equal(validateSelection(CFG, 1, 99, 0, 10, 10).error, 'out-of-bounds');
  assert.equal(validateSelection(CFG, 1, 0, 139, 10, 10).error, 'out-of-bounds');
});

test('non-integer and coercible coordinate values are rejected', () => {
  const invalid = [
    1.5,
    '10.2',
    NaN,
    Infinity,
    -Infinity,
    null,
    undefined,
    'abc',
    {},
    [],
    true,
    false,
    '',
    '  ',
    '1e3',
    '0x10',
  ];

  for (const value of invalid) {
    assert.equal(
      validateSelection(CFG, 1, value, CFG.inventoryTop, 10, 10).error,
      'non-integer',
      `x = ${JSON.stringify(value) ?? String(value)}`
    );
    assert.equal(
      validateSelection(CFG, 1, 0, value, 10, 10).error,
      'non-integer',
      `y = ${JSON.stringify(value) ?? String(value)}`
    );
    assert.equal(
      validateSelection(CFG, 1, 0, CFG.inventoryTop, value, 10).error,
      'non-integer',
      `width = ${JSON.stringify(value) ?? String(value)}`
    );
    assert.equal(
      validateSelection(CFG, 1, 0, CFG.inventoryTop, 10, value).error,
      'non-integer',
      `height = ${JSON.stringify(value) ?? String(value)}`
    );
  }
});

test('a rectangle that crosses the right page edge is rejected', () => {
  assert.equal(
    validateSelection(CFG, 1, CFG.pageWidth - 1, CFG.inventoryTop, 2, 2).error,
    'out-of-bounds'
  );
});

test('a rectangle that crosses the bottom inventory edge is rejected', () => {
  assert.equal(
    validateSelection(CFG, 1, 0, CFG.inventoryBottom - 1, 2, 2).error,
    'outside-inventory'
  );
});

test('selections smaller than the minimum are rejected', () => {
  assert.equal(validateSelection(CFG, 1, 0, CFG.inventoryTop, 1, 2).error, 'too-small');
  assert.equal(validateSelection(CFG, 1, 0, CFG.inventoryTop, 2, 1).error, 'too-small');
});

test('inventory boundaries are inclusive at the top and exclusive at the bottom', () => {
  const inventory = inventoryRect(CFG, 1);
  assert.equal(rectInInventory(CFG, { x: 0, y: CFG.inventoryTop, width: CFG.pageWidth, height: inventory.height }), true);
  assert.equal(validateSelection(CFG, 1, 0, CFG.inventoryTop, 10, 10).ok, true);
  assert.equal(validateSelection(CFG, 1, 0, CFG.inventoryBottom - 10, 10, 10).ok, true);
  assert.equal(validateSelection(CFG, 1, 0, CFG.inventoryTop - 1, 10, 2).error, 'outside-inventory');
  assert.equal(validateSelection(CFG, 1, 0, CFG.inventoryBottom - 1, 10, 2).error, 'outside-inventory');
});

test('cover inventory starts exactly below its double-line header', () => {
  const top = inventoryTopForPage(CFG, 1);
  assert.equal(validateSelection(CFG, 1, 0, top, 2, 2).ok, true);
  assert.equal(validateSelection(CFG, 1, 0, top - 1, 2, 2).error, 'outside-inventory');
  assert.equal(validateSelection(CFG, 1, 0, top, 2, CFG.inventoryBottom - top).ok, true);
});

test('interior inventory starts exactly below its single header line', () => {
  const top = inventoryTopForPage(CFG, 2);
  assert.equal(validateSelection(CFG, 2, 0, top, 2, 2).ok, true);
  assert.equal(validateSelection(CFG, 2, 0, top - 1, 2, 2).error, 'outside-inventory');
  assert.equal(validateSelection(CFG, 2, 0, top, 2, CFG.inventoryBottom - top).ok, true);
});

test('the footer is outside inventory on every page', () => {
  for (let page = 1; page <= CFG.totalPages; page++) {
    assert.equal(
      validateSelection(CFG, page, 0, CFG.inventoryBottom - 1, 2, 2).error,
      'outside-inventory',
      `page ${page}`
    );
  }
});

test('a selection cannot cross from inventory into header or footer', () => {
  assert.equal(validateSelection(CFG, 1, 10, inventoryTopForPage(CFG, 1) - 1, 10, 4).error, 'outside-inventory');
  assert.equal(validateSelection(CFG, 2, 10, inventoryTopForPage(CFG, 2) - 1, 10, 4).error, 'outside-inventory');
  assert.equal(validateSelection(CFG, 1, 10, CFG.inventoryBottom - 2, 10, 4).error, 'outside-inventory');
  assert.equal(validateSelection(CFG, 9, 0, inventoryTopForPage(CFG, 9), CFG.pageWidth, CFG.inventoryBottom - inventoryTopForPage(CFG, 9)).ok, true);
});

test('a dragged rectangle is pulled back out of occupied pixels', () => {
  const occupied = [{ x: 20, y: 20, width: 20, height: 20 }];
  const result = clampAgainstOccupied({ x: 10, y: 10, width: 30, height: 30 }, occupied);
  assert.equal(rectsOverlap(result, occupied[0]), false);
  assert.ok(result.width > 0 && result.height > 0);
});

test('clamping leaves a clear rectangle untouched', () => {
  const proposed = { x: 60, y: 90, width: 20, height: 20 };
  assert.deepEqual(clampAgainstOccupied(proposed, [{ x: 0, y: 0, width: 10, height: 10 }]), proposed);
});

test('clamping against multiple blockers leaves no remaining overlap', () => {
  const occupied = [
    { x: 0, y: CFG.inventoryTop, width: 18, height: 12 },
    { x: 28, y: CFG.inventoryTop + 6, width: 22, height: 18 },
    { x: 60, y: CFG.inventoryTop + 20, width: 25, height: 22 },
  ];

  const proposals = [
    { x: 8, y: CFG.inventoryTop + 4, width: 30, height: 22 },
    { x: 20, y: CFG.inventoryTop + 8, width: 48, height: 28 },
    { x: 50, y: CFG.inventoryTop + 16, width: 35, height: 30 },
  ];

  let checked = 0;
  for (const proposal of proposals) {
    const result = clampAgainstOccupied(proposal, occupied);
    if (result.width <= 0 || result.height <= 0) continue;
    checked++;

    for (const blocker of occupied) {
      assert.equal(rectsOverlap(result, blocker), false);
    }
  }
  assert.ok(checked > 0, 'all multiple-blocker cases collapsed to an empty rectangle');
});

test('runtime buildViews creates a cover followed by two-page spreads', () => {
  const source = readFileSync(new URL('../src/components/Broadsheet.tsx', import.meta.url), 'utf8');
  const match = source.match(
    /function buildViews\(totalPages: number\): PageSlots\[\] \{([\s\S]*?)\n\}/
  );
  assert.ok(match, 'Broadsheet buildViews implementation was not found');

  const buildViewsBody = match[1].replace(/: PageSlots\[\]/g, '');
  const buildViews = new Function(`return function buildViews(totalPages) {${buildViewsBody}}`)() as (
    totalPages: number
  ) => Array<{ left: number | null; right: number | null }>;

  assert.deepEqual(buildViews(1), [{ left: null, right: 1 }]);
  assert.deepEqual(buildViews(2), [
    { left: null, right: 1 },
    { left: 2, right: null },
  ]);
  assert.deepEqual(buildViews(9), [
    { left: null, right: 1 },
    { left: 2, right: 3 },
    { left: 4, right: 5 },
    { left: 6, right: 7 },
    { left: 8, right: 9 },
  ]);
  assert.deepEqual(buildViews(10).at(-1), { left: 10, right: null });
});

test('full-price provider amount is accepted', () => {
  assert.equal(isProviderAmountAcceptable(275, 275, false), true);
  assert.deepEqual(paymentAmountsForOrder(275, false), {
    originalAmountCents: 275,
    actualAmountCents: 275,
    discountAmountCents: 0,
  });
});

test('a verified 100% percentage discount can authorize a zero payment', async () => {
  const payment = {
    total_amount: 0,
    discount_id: 'dsc_full',
    discounts: [
      {
        discount_id: 'dsc_full',
        type: 'percentage',
        amount: 10_000,
        restricted_to: ['pdt_pixel_paper'],
      },
    ],
  };

  assert.equal(hasValidFullDiscountEvidence(payment, 'pdt_pixel_paper', PAYMENT_EVENT_TIME), true);
  assert.equal(
    isProviderAmountAcceptable(
      275,
      0,
      hasValidFullDiscountEvidence(payment, 'pdt_pixel_paper', PAYMENT_EVENT_TIME)
    ),
    true
  );
  assert.deepEqual(paymentAmountsForOrder(275, true), {
    originalAmountCents: 275,
    actualAmountCents: 0,
    discountAmountCents: 275,
  });

  const lookedUp = await hasVerifiedFullDiscountEvidence(
    { total_amount: 0, discount_id: 'dsc_full' },
    'pdt_pixel_paper',
    async () => payment.discounts[0],
    PAYMENT_EVENT_TIME
  );
  assert.equal(lookedUp, true);
});

test('a looked-up discount with a mismatched identity is rejected', async () => {
  assert.equal(
    await hasVerifiedFullDiscountEvidence(
      { total_amount: 0, discount_id: 'dsc_requested' },
      'pdt_pixel_paper',
      async () => ({
        discount_id: 'dsc_returned',
        type: 'percentage',
        amount: 10_000,
        restricted_to: ['pdt_pixel_paper'],
      }),
      PAYMENT_EVENT_TIME
    ),
    false
  );
});

test('zero provider amount without a verified discount is rejected', () => {
  assert.equal(isProviderAmountAcceptable(275, 0, false), false);
});

test('partial provider underpayment is rejected', () => {
  assert.equal(isProviderAmountAcceptable(275, 274, false), false);
});

test('invalid or fake discount evidence is rejected', async () => {
  assert.equal(
    hasValidFullDiscountEvidence(
      { discount: { type: 'percentage', amount: 10_000 } },
      'pdt_pixel_paper',
      PAYMENT_EVENT_TIME
    ),
    false
  );
  assert.equal(
    hasValidFullDiscountEvidence(
      {
        discounts: [
          {
            discount_id: 'dsc_flat',
            type: 'flat',
            amount: 10_000,
            restricted_to: ['pdt_pixel_paper'],
          },
        ],
      },
      'pdt_pixel_paper',
      PAYMENT_EVENT_TIME
    ),
    false
  );
  assert.equal(
    hasValidFullDiscountEvidence(
      {
        discounts: [
          {
            discount_id: 'dsc_other_product',
            type: 'percentage',
            amount: 10_000,
            restricted_to: ['pdt_other'],
          },
        ],
      },
      'pdt_pixel_paper',
      PAYMENT_EVENT_TIME
    ),
    false
  );
  assert.equal(
    hasValidFullDiscountEvidence(
      {
        discounts: [
          {
            discount_id: 'dsc_expired',
            type: 'percentage',
            amount: 10_000,
            restricted_to: [],
            expires_at: '2020-01-01T00:00:00Z',
          },
        ],
      },
      'pdt_pixel_paper',
      PAYMENT_EVENT_TIME
    ),
    false
  );
  assert.equal(
    await hasVerifiedFullDiscountEvidence(
      { total_amount: 0, discount_id: 'dsc_fake' },
      'pdt_pixel_paper',
      async () => ({
        discount_id: 'dsc_fake',
        type: 'percentage',
        amount: 9_999,
        restricted_to: [],
      }),
      PAYMENT_EVENT_TIME
    ),
    false
  );
});

test('transient discount lookup failures propagate for webhook retry', async () => {
  await assert.rejects(
    () =>
      hasVerifiedFullDiscountEvidence(
        { total_amount: 0, discount_id: 'dsc_temporary' },
        'pdt_pixel_paper',
        async () => {
          throw new TransientProviderLookupError(new Error('temporary network failure'));
        },
        PAYMENT_EVENT_TIME
      ),
    (error: unknown) => error instanceof TransientProviderLookupError
  );
});

test('discount expiry is evaluated at the payment event time', () => {
  const paymentTime = Date.parse('2026-01-01T12:00:00.000Z');
  assert.equal(
    hasValidFullDiscountEvidence(
      {
        discount_id: 'dsc_time_bound',
        discounts: [
          {
            discount_id: 'dsc_time_bound',
            type: 'percentage',
            amount: 10_000,
            restricted_to: ['pdt_pixel_paper'],
            starts_at: '2025-12-01T00:00:00.000Z',
            expires_at: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
      'pdt_pixel_paper',
      paymentTime
    ),
    true
  );
});

test('embedded discount details without a top-level identity fail closed', () => {
  assert.equal(
    hasValidFullDiscountEvidence(
      {
        discounts: [
          {
            discount_id: 'dsc_unbound',
            type: 'percentage',
            amount: 10_000,
            restricted_to: ['pdt_pixel_paper'],
          },
        ],
      },
      'pdt_pixel_paper',
      PAYMENT_EVENT_TIME
    ),
    false
  );
});

class FakeWebhookClient {
  pendingEventId: string | null = null;
  released = false;
  destroyed = false;
  private readonly database: FakeWebhookDatabase;

  constructor(database: FakeWebhookDatabase) {
    this.database = database;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<{ id: string }> }> {
    const normalized = sql.trim().toUpperCase();
    if (normalized === 'BEGIN') return { rows: [] };
    if (normalized.startsWith('INSERT INTO WEBHOOK_EVENTS')) {
      return { rows: await this.database.insert(this, String(params[0])) };
    }
    if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      this.database.finish(this, normalized);
      return { rows: [] };
    }
    throw new Error(`Unexpected fake SQL: ${sql}`);
  }

  release(destroy = false): void {
    this.released = true;
    this.destroyed = destroy;
  }
}

class FakeWebhookDatabase {
  private readonly committed = new Set<string>();
  private readonly pending = new Map<
    string,
    { owner: FakeWebhookClient; waiters: Array<() => void> }
  >();

  async connect(): Promise<FakeWebhookClient> {
    return new FakeWebhookClient(this);
  }

  async insert(
    client: FakeWebhookClient,
    eventId: string
  ): Promise<Array<{ id: string }>> {
    if (this.committed.has(eventId)) return [];

    const active = this.pending.get(eventId);
    if (active) {
      await new Promise<void>((resolve) => active.waiters.push(resolve));
      return this.insert(client, eventId);
    }

    client.pendingEventId = eventId;
    this.pending.set(eventId, { owner: client, waiters: [] });
    return [{ id: eventId }];
  }

  finish(client: FakeWebhookClient, statement: 'COMMIT' | 'ROLLBACK'): void {
    if (!client.pendingEventId) return;
    const eventId = client.pendingEventId;
    const active = this.pending.get(eventId);
    if (active?.owner !== client) return;
    if (statement === 'COMMIT') this.committed.add(eventId);
    this.pending.delete(eventId);
    client.pendingEventId = null;
    for (const resolve of active.waiters) resolve();
  }
}

test('concurrent duplicate waits and retries after failed processing', async () => {
  const database = new FakeWebhookDatabase();
  const first = await claimWebhookEvent(
    'evt_concurrent_retry',
    'payment.succeeded',
    database as never
  );
  assert.equal(first.firstTime, true);

  let duplicateSettled = false;
  const duplicatePromise = claimWebhookEvent(
    'evt_concurrent_retry',
    'payment.succeeded',
    database as never
  ).then((claim) => {
    duplicateSettled = true;
    return claim;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(duplicateSettled, false);

  // A failed processor rolls back, allowing the waiting delivery to reclaim
  // the event instead of acknowledging it as a duplicate.
  await first.release();
  const retry = await duplicatePromise;
  assert.equal(retry.firstTime, true);
  await retry.commit();

  const replay = await claimWebhookEvent(
    'evt_concurrent_retry',
    'payment.succeeded',
    database as never
  );
  assert.equal(replay.firstTime, false);
  await replay.commit();
});

const refundRecord: RefundRecord = {
  bookingId: 'booking_conflict',
  sessionId: 'pay_conflict',
  paymentIntentId: 'pay_conflict',
  amountCents: 500,
  currency: 'usd',
  buyerEmail: null,
};

function fakeClaim() {
  return {
    commits: 0,
    releases: 0,
    async commit() {
      this.commits += 1;
    },
    async release() {
      this.releases += 1;
    },
  };
}

class FakeRefundProvider implements RefundProvider {
  createCalls = 0;
  retrieveCalls = 0;
  private snapshot: RefundPaymentSnapshot = {
    refund_status: null,
    refunds: [],
  };

  readonly payments = {
    retrieve: async (_paymentId: string): Promise<RefundPaymentSnapshot> => {
      this.retrieveCalls += 1;
      return this.snapshot;
    },
  };

  readonly refunds = {
    create: async ({ payment_id }: { payment_id: string }): Promise<unknown> => {
      this.createCalls += 1;
      this.snapshot = {
        refund_status: 'full',
        refunds: [{ status: 'succeeded', is_partial: false }],
      };
      return { payment_id };
    },
  };
}

test('successful conflict refund records the refund before claim commit', async () => {
  const provider = new FakeRefundProvider();
  const calls: string[] = [];

  await processConflictRefund('pay_conflict', refundRecord, {} as never, {
    lockRefund: async () => undefined,
    refundPayment: async (paymentId) => {
      calls.push(`refund:${paymentId}`);
      await refundPaymentIfNeeded(paymentId, provider);
    },
    recordRefundedOrder: async (record) => {
      calls.push(`record:${record.sessionId}`);
    },
  });

  assert.deepEqual(calls, ['refund:pay_conflict', 'record:pay_conflict']);
  assert.equal(provider.createCalls, 1);
});

test('refund recording failure returns a retryable failure and releases the claim', async () => {
  const provider = new FakeRefundProvider();
  const claim = fakeClaim();
  let responseStatus = 200;

  try {
    await processClaimedWebhook(claim, () =>
      processConflictRefund('pay_conflict', refundRecord, {} as never, {
        lockRefund: async () => undefined,
        refundPayment: (paymentId) => refundPaymentIfNeeded(paymentId, provider),
        recordRefundedOrder: async () => {
          throw new Error('refund record unavailable');
        },
      })
    );
  } catch {
    responseStatus = 500;
  }

  assert.equal(responseStatus, 500);
  assert.equal(claim.commits, 0);
  assert.equal(claim.releases, 1);
  assert.equal(provider.createCalls, 1);
});

test('a retry after refund recording failure commits one durable refund record', async () => {
  const database = new FakeWebhookDatabase();
  const provider = new FakeRefundProvider();
  let shouldFail = true;
  let refundAttempts = 0;
  const records = new Set<string>();
  const operations = {
    lockRefund: async () => undefined,
    refundPayment: async (paymentId: string) => {
      refundAttempts += 1;
      await refundPaymentIfNeeded(paymentId, provider);
    },
    recordRefundedOrder: async (record: typeof refundRecord) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('temporary database failure');
      }
      records.add(record.sessionId);
    },
  };

  const first = await claimWebhookEvent('evt_refund_retry', 'payment.succeeded', database as never);
  await assert.rejects(() =>
    processClaimedWebhook(first, () =>
      processConflictRefund('pay_conflict', refundRecord, {} as never, operations)
    )
  );

  const retry = await claimWebhookEvent('evt_refund_retry', 'payment.succeeded', database as never);
  assert.equal(retry.firstTime, true);
  await processClaimedWebhook(retry, () =>
    processConflictRefund('pay_conflict', refundRecord, {} as never, operations)
  );

  assert.equal(refundAttempts, 2);
  assert.equal(provider.createCalls, 1);
  assert.equal(provider.retrieveCalls, 2);
  assert.equal(records.size, 1);
});

test('duplicate refund webhook is acknowledged without a second refund or record', async () => {
  const database = new FakeWebhookDatabase();
  const provider = new FakeRefundProvider();
  let refundCalls = 0;
  let recordCalls = 0;
  const operations = {
    lockRefund: async () => undefined,
    refundPayment: async (paymentId: string) => {
      refundCalls += 1;
      await refundPaymentIfNeeded(paymentId, provider);
    },
    recordRefundedOrder: async () => {
      recordCalls += 1;
    },
  };

  const first = await claimWebhookEvent('evt_refund_duplicate', 'payment.succeeded', database as never);
  await processClaimedWebhook(first, () =>
    processConflictRefund('pay_conflict', refundRecord, {} as never, operations)
  );

  const duplicate = await claimWebhookEvent(
    'evt_refund_duplicate',
    'payment.succeeded',
    database as never
  );
  assert.equal(duplicate.firstTime, false);
  await duplicate.commit();

  assert.equal(refundCalls, 1);
  assert.equal(recordCalls, 1);
  assert.equal(provider.createCalls, 1);
});

test('provider refund state prevents a second refund request after recovery', async () => {
  const provider = new FakeRefundProvider();

  await refundPaymentIfNeeded('pay_conflict', provider);
  await refundPaymentIfNeeded('pay_conflict', provider);

  assert.equal(provider.createCalls, 1);
  assert.equal(provider.retrieveCalls, 2);
});

test('failed refund processing rolls back the claim so the event remains retryable', async () => {
  const database = new FakeWebhookDatabase();
  const first = await claimWebhookEvent('evt_refund_rollback', 'payment.succeeded', database as never);

  await assert.rejects(() =>
    processClaimedWebhook(first, async () => {
      throw new Error('provider refund failed');
    })
  );

  const retry = await claimWebhookEvent('evt_refund_rollback', 'payment.succeeded', database as never);
  assert.equal(retry.firstTime, true);
  await retry.commit();
});
