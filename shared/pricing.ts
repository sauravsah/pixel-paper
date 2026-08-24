/**
 * THE INTERNET TIMES — PRICING ENGINE
 * ===================================
 *
 * This module is imported by BOTH the Express server and the React client.
 *
 * That is deliberate and it is the whole point: there is exactly one
 * implementation of the pricing algorithm in this codebase, so the number the
 * buyer watches while dragging can never drift away from the number Stripe
 * charges. The server still recomputes every price from raw integer
 * coordinates before it creates a payment session — the client's figure is
 * treated as a preview and nothing more — but both sides run this same code.
 *
 * Everything here is a pure function of (config, page, x, y, width, height).
 * No clocks, no randomness, no I/O, no globals.
 */

import type { PricingConfig, PricingTier } from './pricing-config.ts';

/**
 * Number of samples per axis used to average the attention field across a
 * rectangle. Fixed so client and server always agree to the last decimal.
 */
const FIELD_SAMPLES = 16;

/** Decimal places the averaged multiplier is rounded to before it is used. */
const MULTIPLIER_PRECISION = 6;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Quote {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelCount: number;
  /** Base price per pixel before multipliers. */
  baseRate: number;
  pageMultiplier: number;
  /** Attention multiplier averaged across the whole selected rectangle. */
  positionMultiplier: number;
  /** What a single pixel in this exact rectangle actually costs. */
  effectiveRate: number;
  /** Total in whole cents. This is the figure sent to Stripe. */
  amountCents: number;
  /** Total in dollars, derived from `amountCents`. For display only. */
  totalPrice: number;
  /** True when the raw price fell below the minimum charge and was lifted. */
  minimumApplied: boolean;
  tier: PricingTier;
  /** Human-readable position, e.g. "Top Right". */
  positionLabel: string;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Smoothstep easing. Gives the vertical falloff a natural S-curve. */
function smoothstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/**
 * The attention field at a single normalised point on a page.
 *
 * `u` runs 0 (left edge) to 1 (right edge), `v` runs 0 (top) to 1 (bottom).
 *
 * Three effects combine:
 *   1. Vertical — the top of a page is prime real estate, the bottom is not.
 *   2. Horizontal — the right side outranks the left.
 *   3. A soft hot spot slightly above the geometric centre, where the eye
 *      naturally lands on a printed page.
 *
 * The result is a smooth continuous surface rather than a grid of blocks, so
 * moving a selection a few pixels changes the price a little, not in jumps.
 */
export function positionMultiplierAtPoint(config: PricingConfig, u: number, v: number): number {
  const p = config.position;

  const nu = clamp(u, 0, 1);
  const nv = clamp(v, 0, 1);

  // 1. Vertical attention: topWeight at the top, bottomWeight at the bottom.
  const vertical = p.topWeight + (p.bottomWeight - p.topWeight) * smoothstep(nv);

  // 2. Horizontal attention: linear from leftWeight to rightWeight.
  const horizontal = p.leftWeight + (p.rightWeight - p.leftWeight) * nu;

  // 3. Gaussian hot spot around the optical centre.
  const dx = (nu - p.focusX) / p.focusRadiusX;
  const dy = (nv - p.focusY) / p.focusRadiusY;
  const focus = 1 + p.focusStrength * Math.exp(-(dx * dx + dy * dy));

  return clamp(vertical * horizontal * focus, p.min, p.max);
}

/**
 * Average the attention field across a rectangle.
 *
 * A large block that spans premium and cheap areas is priced on what it
 * actually covers, so nobody can game the system by anchoring one corner in a
 * cheap zone.
 */
export function averagePositionMultiplier(config: PricingConfig, rect: Rect): number {
  const { pageWidth, pageHeight } = config;
  let sum = 0;

  for (let i = 0; i < FIELD_SAMPLES; i++) {
    // Sample at cell centres so the result is symmetric.
    const u = (rect.x + ((i + 0.5) * rect.width) / FIELD_SAMPLES) / pageWidth;

    for (let j = 0; j < FIELD_SAMPLES; j++) {
      const v = (rect.y + ((j + 0.5) * rect.height) / FIELD_SAMPLES) / pageHeight;
      sum += positionMultiplierAtPoint(config, u, v);
    }
  }

  const average = sum / (FIELD_SAMPLES * FIELD_SAMPLES);
  return round(average, MULTIPLIER_PRECISION);
}

/** Map a position multiplier onto a tier label for the price map. */
export function tierForMultiplier(config: PricingConfig, multiplier: number): PricingTier {
  const t = config.tierThresholds;
  if (multiplier >= t.premium) return 'premium';
  if (multiplier >= t.high) return 'high';
  if (multiplier >= t.medium) return 'medium';
  return 'standard';
}

/** Describe where a rectangle sits, e.g. "Upper Right" or "Bottom Left". */
export function positionLabel(config: PricingConfig, rect: Rect): string {
  const cx = (rect.x + rect.width / 2) / config.pageWidth;
  const cy = (rect.y + rect.height / 2) / config.pageHeight;

  const vertical =
    cy < 0.2 ? 'Top' : cy < 0.4 ? 'Upper' : cy < 0.6 ? 'Middle' : cy < 0.8 ? 'Lower' : 'Bottom';

  const horizontal = cx < 0.36 ? 'Left' : cx < 0.64 ? 'Centre' : 'Right';

  return `${vertical} ${horizontal}`;
}

/**
 * Price a rectangle.
 *
 * Coordinates must already be validated integers inside the page. Callers on
 * the server go through `validateSelection` first; the client clamps while
 * dragging. This function does not guess or repair bad input, it just prices
 * what it is given.
 */
export function calculateQuote(
  config: PricingConfig,
  pageNumber: number,
  rect: Rect
): Quote {
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const normalised: Rect = { x, y, width, height };

  const pixelCount = width * height;
  const pageMultiplier = config.pageMultipliers[pageNumber] ?? 1;
  const positionMultiplier = averagePositionMultiplier(config, normalised);

  // 10 decimals is far finer than a cent at any realistic pixel count, and
  // rounding here keeps the client and server bit-identical.
  const effectiveRate = round(config.baseRate * pageMultiplier * positionMultiplier, 10);

  const rawCents = pixelCount * effectiveRate * 100;
  const flooredCents = Math.max(config.minChargeCents, Math.round(rawCents));
  const amountCents = Math.min(config.maxChargeCents, flooredCents);

  return {
    pageNumber,
    x,
    y,
    width,
    height,
    pixelCount,
    baseRate: config.baseRate,
    pageMultiplier,
    positionMultiplier,
    effectiveRate,
    amountCents,
    totalPrice: amountCents / 100,
    minimumApplied: Math.round(rawCents) < config.minChargeCents,
    tier: tierForMultiplier(config, positionMultiplier),
    positionLabel: positionLabel(config, normalised),
  };
}

/**
 * Build a coarse grid of tiers for the price-map overlay.
 *
 * The map is drawn from the same field that sets the price, so what a buyer
 * sees shaded as "premium" really is the expensive part of the page. Using a
 * fine grid keeps it looking like a gradient over newsprint rather than a set
 * of blocks.
 */
export interface PriceMapCell {
  /** Normalised position and size, 0..1, for direct use as CSS percentages. */
  u: number;
  v: number;
  w: number;
  h: number;
  multiplier: number;
  tier: PricingTier;
}

export function buildPriceMap(
  config: PricingConfig,
  columns = 12,
  rows = 18
): PriceMapCell[] {
  const cells: PriceMapCell[] = [];
  const w = 1 / columns;
  const h = 1 / rows;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const u = i * w;
      const v = j * h;
      const multiplier = positionMultiplierAtPoint(config, u + w / 2, v + h / 2);
      cells.push({
        u,
        v,
        w,
        h,
        multiplier: round(multiplier, 4),
        tier: tierForMultiplier(config, multiplier),
      });
    }
  }

  return cells;
}
