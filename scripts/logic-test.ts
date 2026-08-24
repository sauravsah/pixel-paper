/**
 * Pure-logic test suite for the pricing engine and geometry rules.
 *
 * Runs with no dependencies installed:
 *
 *     node --experimental-strip-types --test scripts/logic-test.ts
 *
 * These are the parts of the system where a subtle mistake silently charges the
 * wrong amount or sells the same pixels twice, so they are tested directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PRICING_CONFIG as CFG } from '../shared/pricing-config.ts';
import {
  calculateQuote,
  positionMultiplierAtPoint,
  averagePositionMultiplier,
  buildPriceMap,
  tierForMultiplier,
  positionLabel,
} from '../shared/pricing.ts';
import {
  rectsOverlap,
  validateSelection,
  clampAgainstOccupied,
  pointInRect,
} from '../shared/geometry.ts';

const BOX = { width: 200, height: 200 };
const quoteAt = (page: number, x: number, y: number, w = BOX.width, h = BOX.height) =>
  calculateQuote(CFG, page, { x, y, width: w, height: h });

// --------------------------------------------------------------------------
// Position field: top > bottom, right > left, centre elevated
// --------------------------------------------------------------------------

test('top of a page is worth more than the bottom', () => {
  const top = positionMultiplierAtPoint(CFG, 0.5, 0.02);
  const bottom = positionMultiplierAtPoint(CFG, 0.5, 0.98);
  assert.ok(top > bottom, `top ${top} should exceed bottom ${bottom}`);
});

test('right side is worth more than the left at the same height', () => {
  for (const v of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const left = positionMultiplierAtPoint(CFG, 0.02, v);
    const right = positionMultiplierAtPoint(CFG, 0.98, v);
    assert.ok(right > left, `at v=${v}: right ${right} should exceed left ${left}`);
  }
});

test('attention hot spot is the peak of the field', () => {
  const focus = positionMultiplierAtPoint(CFG, CFG.position.focusX, CFG.position.focusY);
  const offCentre = positionMultiplierAtPoint(CFG, CFG.position.focusX, 0.7);
  assert.ok(focus > offCentre);
});

test('field stays inside its configured floor and ceiling', () => {
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 40; j++) {
      const m = positionMultiplierAtPoint(CFG, i / 40, j / 40);
      assert.ok(m >= CFG.position.min && m <= CFG.position.max, `out of range: ${m}`);
    }
  }
});

test('field is continuous - a one pixel nudge never jumps the price', () => {
  let worst = 0;
  for (let px = 0; px < CFG.pageWidth - 1; px += 7) {
    for (let py = 0; py < CFG.pageHeight - 1; py += 11) {
      const a = positionMultiplierAtPoint(CFG, px / CFG.pageWidth, py / CFG.pageHeight);
      const b = positionMultiplierAtPoint(CFG, (px + 1) / CFG.pageWidth, (py + 1) / CFG.pageHeight);
      worst = Math.max(worst, Math.abs(a - b));
    }
  }
  assert.ok(worst < 0.005, `largest single-pixel step was ${worst}`);
});

// --------------------------------------------------------------------------
// Page multipliers follow the specified order
// --------------------------------------------------------------------------

test('page multipliers descend from page 1 to page 6 exactly as configured', () => {
  assert.deepEqual(CFG.pageMultipliers, { 1: 1.5, 2: 1.25, 3: 1.15, 4: 1.1, 5: 1.0, 6: 0.9 });
});

test('the same rectangle costs strictly less on each later page', () => {
  const prices = [1, 2, 3, 4, 5, 6].map((p) => quoteAt(p, 400, 300).amountCents);
  for (let i = 1; i < prices.length; i++) {
    assert.ok(prices[i] < prices[i - 1], `page ${i + 1} (${prices[i]}) should undercut page ${i} (${prices[i - 1]})`);
  }
});

// --------------------------------------------------------------------------
// Quote arithmetic
// --------------------------------------------------------------------------

test('effective rate is base x page x position, and total is rate x pixels', () => {
  const q = quoteAt(2, 300, 200, 286, 240);
  const expectedRate =
    Math.round(CFG.baseRate * q.pageMultiplier * q.positionMultiplier * 1e10) / 1e10;

  assert.equal(q.pixelCount, 286 * 240);
  assert.equal(q.effectiveRate, expectedRate);
  assert.equal(q.amountCents, Math.round(q.pixelCount * q.effectiveRate * 100));
  assert.equal(q.totalPrice, q.amountCents / 100);
});

test('amount is always a whole number of cents', () => {
  for (const [x, y, w, h] of [[0, 0, 40, 40], [137, 419, 283, 161], [500, 700, 500, 700], [0, 0, 1000, 1400]]) {
    const q = quoteAt(3, x, y, w, h);
    assert.ok(Number.isInteger(q.amountCents), `${q.amountCents} is not an integer`);
  }
});

test('price rises with area when position is held constant', () => {
  const small = quoteAt(4, 100, 100, 100, 100).amountCents;
  const large = quoteAt(4, 100, 100, 400, 400).amountCents;
  assert.ok(large > small);
});

test('identical input produces identical output every time', () => {
  const a = quoteAt(1, 233, 421, 287, 163);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(quoteAt(1, 233, 421, 287, 163), a);
  }
});

test('a right-hand block outprices the same block mirrored to the left', () => {
  const left = quoteAt(3, 40, 400, 300, 200).amountCents;
  const right = quoteAt(3, CFG.pageWidth - 340, 400, 300, 200).amountCents;
  assert.ok(right > left, `right ${right} should exceed left ${left}`);
});

test('a top block outprices the same block moved to the bottom', () => {
  const top = quoteAt(3, 350, 30, 300, 200).amountCents;
  const bottom = quoteAt(3, 350, CFG.pageHeight - 230, 300, 200).amountCents;
  assert.ok(top > bottom, `top ${top} should exceed bottom ${bottom}`);
});

test('averaging is symmetric about the vertical axis of the field', () => {
  // Mirroring a rectangle horizontally must mirror the horizontal weighting.
  const a = averagePositionMultiplier(CFG, { x: 0, y: 500, width: 200, height: 200 });
  const b = averagePositionMultiplier(CFG, { x: 800, y: 500, width: 200, height: 200 });
  const mid = averagePositionMultiplier(CFG, { x: 400, y: 500, width: 200, height: 200 });
  assert.ok(a < mid && mid < b);
});

test('a big block spanning the whole page averages out to the middle of the range', () => {
  const full = averagePositionMultiplier(CFG, { x: 0, y: 0, width: CFG.pageWidth, height: CFG.pageHeight });
  assert.ok(full > 0.9 && full < 1.25, `full page average was ${full}`);
});

// --------------------------------------------------------------------------
// Stripe's minimum charge
// --------------------------------------------------------------------------

test('minimum charge never falls below what Stripe will accept', () => {
  assert.ok(CFG.minChargeCents >= 50, 'Stripe rejects card charges under 50c USD');
  const tiny = quoteAt(6, 0, CFG.pageHeight - CFG.minSelectionHeight, CFG.minSelectionWidth, CFG.minSelectionHeight);
  assert.equal(tiny.amountCents, CFG.minChargeCents);
  assert.equal(tiny.minimumApplied, true);
});

test('a normal sized block is priced on its own merits, not the floor', () => {
  const q = quoteAt(1, 300, 200, 400, 300);
  assert.equal(q.minimumApplied, false);
  assert.ok(q.amountCents > CFG.minChargeCents);
});

test('no selection can exceed the configured ceiling', () => {
  const whole = quoteAt(1, 0, 0, CFG.pageWidth, CFG.pageHeight);
  assert.ok(whole.amountCents <= CFG.maxChargeCents);
});

// --------------------------------------------------------------------------
// Labels and tiers
// --------------------------------------------------------------------------

test('position labels describe the rectangle in plain language', () => {
  assert.equal(positionLabel(CFG, { x: 800, y: 20, width: 150, height: 100 }), 'Top Right');
  assert.equal(positionLabel(CFG, { x: 20, y: 1250, width: 150, height: 100 }), 'Bottom Left');
  assert.equal(positionLabel(CFG, { x: 430, y: 660, width: 140, height: 100 }), 'Middle Centre');
});

test('tiers are ordered and the price map covers every tier', () => {
  assert.equal(tierForMultiplier(CFG, 1.5), 'premium');
  assert.equal(tierForMultiplier(CFG, 1.2), 'high');
  assert.equal(tierForMultiplier(CFG, 1.0), 'medium');
  assert.equal(tierForMultiplier(CFG, 0.8), 'standard');

  const tiers = new Set(buildPriceMap(CFG).map((c) => c.tier));
  for (const expected of ['premium', 'high', 'medium', 'standard']) {
    assert.ok(tiers.has(expected as never), `price map never produces "${expected}"`);
  }
});

test('price map cells tile the page exactly once', () => {
  const cells = buildPriceMap(CFG, 12, 18);
  assert.equal(cells.length, 12 * 18);
  const area = cells.reduce((sum, c) => sum + c.w * c.h, 0);
  assert.ok(Math.abs(area - 1) < 1e-9, `cells cover ${area} of the page`);
});

// --------------------------------------------------------------------------
// Overlap detection - the rule that stops pixels being sold twice
// --------------------------------------------------------------------------

test('overlapping rectangles are detected', () => {
  const a = { x: 100, y: 100, width: 100, height: 100 };
  assert.ok(rectsOverlap(a, { x: 150, y: 150, width: 100, height: 100 }), 'corner overlap');
  assert.ok(rectsOverlap(a, { x: 120, y: 120, width: 10, height: 10 }), 'fully contained');
  assert.ok(rectsOverlap(a, { x: 0, y: 0, width: 500, height: 500 }), 'fully containing');
  assert.ok(rectsOverlap(a, { x: 199, y: 199, width: 50, height: 50 }), 'single pixel overlap');
});

test('rectangles that only touch edges do not overlap', () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(rectsOverlap(a, { x: 100, y: 0, width: 100, height: 100 }), false, 'flush right');
  assert.equal(rectsOverlap(a, { x: 0, y: 100, width: 100, height: 100 }), false, 'flush below');
  assert.equal(rectsOverlap(a, { x: 100, y: 100, width: 100, height: 100 }), false, 'diagonal corner');
});

test('overlap test is symmetric', () => {
  const pairs = [
    [{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }],
    [{ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 10, width: 10, height: 10 }],
    [{ x: 3, y: 90, width: 40, height: 4 }, { x: 0, y: 0, width: 1000, height: 1400 }],
  ];
  for (const [a, b] of pairs) {
    assert.equal(rectsOverlap(a, b), rectsOverlap(b, a));
  }
});

test('point containment uses the same half-open rule', () => {
  const r = { x: 10, y: 10, width: 10, height: 10 };
  assert.ok(pointInRect(r, 10, 10), 'first owned pixel');
  assert.ok(pointInRect(r, 19, 19), 'last owned pixel');
  assert.equal(pointInRect(r, 20, 19), false, 'one past the right edge');
  assert.equal(pointInRect(r, 9, 10), false, 'one before the left edge');
});

// --------------------------------------------------------------------------
// Server-side input validation
// --------------------------------------------------------------------------

test('a well formed selection validates', () => {
  const r = validateSelection(CFG, 2, 100, 200, 300, 400);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rect, { x: 100, y: 200, width: 300, height: 400 });
});

test('bad pages are rejected', () => {
  for (const page of [0, 7, -1, 1.5, 'two', null, undefined, NaN, Infinity, true, false, [], {}, '']) {
    assert.equal(validateSelection(CFG, page, 0, 0, 100, 100).ok, false, `page ${String(page)}`);
  }
});

test('every page 1..6 is accepted', () => {
  for (let page = 1; page <= CFG.totalPages; page++) {
    assert.equal(validateSelection(CFG, page, 0, 0, 100, 100).ok, true, `page ${page}`);
  }
});

test('coordinates that are not real whole numbers are rejected', () => {
  // Number() would coerce null, '', [] and false to 0 and true to 1, which
  // would price a rectangle the buyer never selected. None may slip through.
  const bad = [1.5, '10.2', NaN, Infinity, -Infinity, null, undefined, 'abc', {}, [], true, false, '', '  ', '1e3', '0x10'];
  for (const value of bad) {
    assert.equal(validateSelection(CFG, 1, value, 0, 100, 100).ok, false, `x = ${JSON.stringify(value) ?? String(value)}`);
    assert.equal(validateSelection(CFG, 1, 0, value, 100, 100).ok, false, `y = ${JSON.stringify(value) ?? String(value)}`);
    assert.equal(validateSelection(CFG, 1, 0, 0, value, 100).ok, false, `w = ${JSON.stringify(value) ?? String(value)}`);
    assert.equal(validateSelection(CFG, 1, 0, 0, 100, value).ok, false, `h = ${JSON.stringify(value) ?? String(value)}`);
  }
});

test('numeric strings from a form post are accepted', () => {
  const r = validateSelection(CFG, '3', '100', '200', '300', '400');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rect, { x: 100, y: 200, width: 300, height: 400 });
});

test('selections outside the page are rejected', () => {
  assert.equal(validateSelection(CFG, 1, -1, 0, 100, 100).error, 'out-of-bounds');
  assert.equal(validateSelection(CFG, 1, 0, -1, 100, 100).error, 'out-of-bounds');
  assert.equal(validateSelection(CFG, 1, 950, 0, 100, 100).error, 'out-of-bounds');
  assert.equal(validateSelection(CFG, 1, 0, 1350, 100, 100).error, 'out-of-bounds');
  assert.equal(validateSelection(CFG, 1, 0, 0, 1001, 100).error, 'out-of-bounds');
});

test('selections smaller than the minimum are rejected', () => {
  assert.equal(validateSelection(CFG, 1, 0, 0, 10, 10).error, 'too-small');
  assert.equal(validateSelection(CFG, 1, 0, 0, CFG.minSelectionWidth, 1).error, 'too-small');
  assert.equal(validateSelection(CFG, 1, 0, 0, 0, 0).error, 'too-small');
  assert.equal(validateSelection(CFG, 1, 0, 0, -50, -50).error, 'too-small');
});

test('a selection filling the entire page is legal', () => {
  assert.equal(validateSelection(CFG, 6, 0, 0, CFG.pageWidth, CFG.pageHeight).ok, true);
});

// --------------------------------------------------------------------------
// Drag clamping (a convenience for the cursor, never a security control)
// --------------------------------------------------------------------------

test('a dragged rectangle is pulled back out of occupied pixels', () => {
  const occupied = [{ x: 200, y: 200, width: 200, height: 200 }];
  const result = clampAgainstOccupied({ x: 100, y: 100, width: 300, height: 300 }, occupied);
  assert.equal(rectsOverlap(result, occupied[0]), false, 'clamped result still overlaps');
  assert.ok(result.width > 0 && result.height > 0);
});

test('clamping leaves a clear rectangle untouched', () => {
  const proposed = { x: 600, y: 900, width: 200, height: 200 };
  assert.deepEqual(clampAgainstOccupied(proposed, [{ x: 0, y: 0, width: 100, height: 100 }]), proposed);
});

test('clamping against many blocks never leaves an overlap', () => {
  const occupied = [
    { x: 0, y: 0, width: 300, height: 150 },
    { x: 400, y: 100, width: 250, height: 250 },
    { x: 700, y: 0, width: 300, height: 400 },
    { x: 100, y: 600, width: 500, height: 300 },
  ];

  let checked = 0;
  for (let x = 0; x <= 800; x += 50) {
    for (let y = 0; y <= 1200; y += 50) {
      const out = clampAgainstOccupied({ x, y, width: 200, height: 200 }, occupied);
      if (out.width <= 0 || out.height <= 0) continue;
      for (const taken of occupied) {
        assert.equal(rectsOverlap(out, taken), false, `overlap left at ${x},${y}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 50, `only ${checked} cases exercised`);
});

// --------------------------------------------------------------------------
// Worked example from the specification
// --------------------------------------------------------------------------

test('worked example: 286 x 240 on page 2 prices in a sensible range', () => {
  const q = quoteAt(2, 640, 180, 286, 240);
  assert.equal(q.pixelCount, 68_640);
  assert.equal(q.pageMultiplier, 1.25);
  assert.equal(q.positionLabel, 'Upper Right');
  assert.equal(q.tier, 'premium');
  assert.ok(q.totalPrice > 5 && q.totalPrice < 20, `unexpected total $${q.totalPrice}`);
  console.log(
    `      -> ${q.width}x${q.height}px, ${q.pixelCount.toLocaleString()} px, ` +
      `page x${q.pageMultiplier}, position x${q.positionMultiplier} (${q.positionLabel}, ${q.tier}), ` +
      `rate $${q.effectiveRate.toFixed(8)}/px, total $${q.totalPrice.toFixed(2)}`
  );
});

test('report the corner-to-corner spread for a 300x200 block on page 1', () => {
  const spots: Array<[string, number, number]> = [
    ['top left    ', 0, 0],
    ['top right   ', 700, 0],
    ['centre      ', 350, 400],
    ['bottom left ', 0, 1200],
    ['bottom right', 700, 1200],
  ];
  const prices = spots.map(([label, x, y]) => {
    const q = quoteAt(1, x, y, 300, 200);
    console.log(`      -> ${label}  x${q.positionMultiplier.toFixed(4)}  $${q.totalPrice.toFixed(2)}  ${q.tier}`);
    return q.totalPrice;
  });
  assert.ok(Math.max(...prices) > Math.min(...prices) * 1.4, 'position should move the price meaningfully');
});
