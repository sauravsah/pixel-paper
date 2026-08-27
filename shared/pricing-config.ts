/**
 * PIXEL PRESS — CENTRAL PRICING & INVENTORY CONFIGURATION
 * =======================================================
 *
 * Pixel Units are logical newspaper inventory units, not screen pixels.
 * Pricing in V1 depends only on page/spread tier and unit count:
 *
 *   Pixel Units x base rate x page multiplier
 *
 * Exact visual position is intentionally not part of V1 pricing.
 */

export interface PricingConfig {
  /** Logical Pixel Unit resolution of every page. */
  pageWidth: number;
  pageHeight: number;

  /** Inclusive top and exclusive bottom rows of purchasable page inventory. */
  inventoryTop: number;
  inventoryBottom: number;

  /** Initial launch pages. Administrators can add pages in the database-backed architecture. */
  totalPages: number;

  /** Base price in USD for one logical Pixel Unit. */
  baseRate: number;

  /** Per-page multiplier, keyed by page number. */
  pageMultipliers: Record<number, number>;

  /** Smallest rectangle that may be purchased, in logical Pixel Units. */
  minSelectionWidth: number;
  minSelectionHeight: number;

  /** Payment-provider lower bound, in cents. */
  minChargeCents: number;

  /** Upper bound on one charge, in cents. */
  maxChargeCents: number;

  /** How long a pending checkout holds inventory before release. */
  pendingHoldMinutes: number;

  /** Thresholds that map page multipliers onto editorial pricing labels. */
  tierThresholds: {
    premium: number;
    high: number;
    medium: number;
  };
}

export const PRICING_CONFIG: PricingConfig = {
  pageWidth: 100,
  pageHeight: 140,
  // The masthead and footer are printed furniture, not purchasable inventory.
  inventoryTop: 28,
  inventoryBottom: 132,
  totalPages: 9,

  // $0.01 per Pixel Unit.
  baseRate: 0.01,

  pageMultipliers: {
    1: 5.0,
    2: 2.5,
    3: 2.5,
    4: 1.75,
    5: 1.75,
    6: 1.25,
    7: 1.25,
    8: 1.0,
    9: 1.0,
  },

  minSelectionWidth: 2,
  minSelectionHeight: 2,

  minChargeCents: 50,
  maxChargeCents: 5_000_00,

  pendingHoldMinutes: 20,

  tierThresholds: {
    premium: 5.0,
    high: 2.5,
    medium: 1.25,
  },
};

export type PricingTier = 'premium' | 'high' | 'medium' | 'standard';
