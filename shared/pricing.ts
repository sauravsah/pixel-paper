/**
 * PIXEL PRESS — PRICING ENGINE
 * ============================
 *
 * Imported by both the Express server and React client. The browser may preview
 * a quote while the buyer selects space, but checkout always recomputes the
 * amount server-side from page number and logical Pixel Unit dimensions.
 */

import type { PricingConfig, PricingTier } from './pricing-config.ts';

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
  /** Base price per logical Pixel Unit before page multiplier. */
  baseRate: number;
  pageMultiplier: number;
  /** Kept for compatibility with existing UI/data rows; V1 position pricing is neutral. */
  positionMultiplier: number;
  /** What a single logical Pixel Unit on this page tier costs. */
  effectiveRate: number;
  /** Total in whole cents. This is the figure sent to the payment provider. */
  amountCents: number;
  /** Total in dollars, derived from `amountCents`. For display only. */
  totalPrice: number;
  /** True when the raw price fell below the minimum charge and was lifted. */
  minimumApplied: boolean;
  tier: PricingTier;
  /** Human-readable page/spread tier label. */
  positionLabel: string;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Retained for the price-map UI; position no longer changes price in V1. */
export function positionMultiplierAtPoint(_config: PricingConfig, _u: number, _v: number): number {
  return 1;
}

/** Retained for compatibility; every rectangle has a neutral position multiplier. */
export function averagePositionMultiplier(_config: PricingConfig, _rect: Rect): number {
  return 1;
}

/** Map a page multiplier onto a tier label. */
export function tierForMultiplier(config: PricingConfig, multiplier: number): PricingTier {
  const t = config.tierThresholds;
  if (multiplier >= t.premium) return 'premium';
  if (multiplier >= t.high) return 'high';
  if (multiplier >= t.medium) return 'medium';
  return 'standard';
}

export function positionLabel(_config: PricingConfig, _rect: Rect): string {
  return 'Page tier';
}

export function calculateQuote(
  config: PricingConfig,
  pageNumber: number,
  rect: Rect
): Quote {
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const pixelCount = width * height;
  const pageMultiplier = config.pageMultipliers[pageNumber] ?? 1;
  const positionMultiplier = 1;
  const effectiveRate = round(config.baseRate * pageMultiplier, 10);

  const rawCents = pixelCount * effectiveRate * 100;
  const roundedCents = Math.round(rawCents);
  const amountCents = Math.min(config.maxChargeCents, Math.max(config.minChargeCents, roundedCents));

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
    minimumApplied: roundedCents < config.minChargeCents,
    tier: tierForMultiplier(config, pageMultiplier),
    positionLabel: `Page ${pageNumber} tier`,
  };
}

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
  _config: PricingConfig,
  columns = 12,
  rows = 18
): PriceMapCell[] {
  const cells: PriceMapCell[] = [];
  const w = 1 / columns;
  const h = 1 / rows;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      cells.push({
        u: i * w,
        v: j * h,
        w,
        h,
        multiplier: 1,
        tier: 'standard',
      });
    }
  }

  return cells;
}
