/**
 * THE INTERNET TIMES — CENTRAL PRICING & CANVAS CONFIGURATION
 * ============================================================
 *
 * This is the ONE place where pricing and page geometry are defined.
 *
 * The server treats this file as authoritative and serves it to the browser via
 * `GET /api/config`. The browser never hard-codes any of these numbers, so you
 * can change anything here, restart the server, and both the newspaper UI and
 * the money that actually gets charged move together.
 *
 * Pricing depends ONLY on: page number, position on the page, visual attention,
 * and pixel count. It never depends on who is buying or what they are promoting.
 * There are no advertiser categories anywhere in this system.
 */

export interface PricingConfig {
  /** Logical pixel resolution of every page. All coordinates are integers in this space. */
  pageWidth: number;
  pageHeight: number;

  /** Number of permanent pages in the newspaper. */
  totalPages: number;

  /** Base price in USD for a single pixel, before any multipliers. */
  baseRate: number;

  /** Per-page multiplier, keyed by page number. */
  pageMultipliers: Record<number, number>;

  /** Shape of the continuous position-attention field. See `positionMultiplier`. */
  position: {
    /** Multiplier at the very top edge of the page. */
    topWeight: number;
    /** Multiplier at the very bottom edge of the page. */
    bottomWeight: number;
    /** Multiplier at the left edge. */
    leftWeight: number;
    /** Multiplier at the right edge. Keep above `leftWeight` so right costs more. */
    rightWeight: number;
    /** Normalised (0..1) centre of the eye-attention hot spot. */
    focusX: number;
    focusY: number;
    /** How wide the hot spot spreads, in normalised units. */
    focusRadiusX: number;
    focusRadiusY: number;
    /** Extra multiplier at the exact centre of the hot spot (0.10 = +10%). */
    focusStrength: number;
    /** Hard floor and ceiling on the position multiplier. */
    min: number;
    max: number;
  };

  /** Smallest rectangle that may be purchased, in logical pixels. */
  minSelectionWidth: number;
  minSelectionHeight: number;

  /**
   * Floor on any single charge, in cents.
   * Card networks reject charges below 50c USD, so this must stay >= 50.
   */
  minChargeCents: number;

  /** Upper bound on a single charge, in cents. A guard against runaway input. */
  maxChargeCents: number;

  /** How long a pending checkout holds its pixels before the area is released. */
  pendingHoldMinutes: number;

  /** Thresholds that turn a position multiplier into a human-facing tier label. */
  tierThresholds: {
    premium: number;
    high: number;
    medium: number;
  };
}

export const PRICING_CONFIG: PricingConfig = {
  pageWidth: 1000,
  pageHeight: 1400,
  totalPages: 6,

  // $0.0001 per pixel === $100 per million pixels.
  baseRate: 0.0001,

  pageMultipliers: {
    1: 1.5,
    2: 1.25,
    3: 1.15,
    4: 1.1,
    5: 1.0,
    6: 0.9,
  },

  position: {
    topWeight: 1.3,
    bottomWeight: 0.82,
    leftWeight: 0.94,
    rightWeight: 1.1,
    focusX: 0.5,
    focusY: 0.34,
    focusRadiusX: 0.42,
    focusRadiusY: 0.3,
    focusStrength: 0.1,
    min: 0.7,
    max: 1.75,
  },

  minSelectionWidth: 40,
  minSelectionHeight: 40,

  minChargeCents: 50,
  maxChargeCents: 5_000_00,

  pendingHoldMinutes: 20,

  tierThresholds: {
    premium: 1.34,
    high: 1.16,
    medium: 0.98,
  },
};

export type PricingTier = 'premium' | 'high' | 'medium' | 'standard';
