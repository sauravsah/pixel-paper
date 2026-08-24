/**
 * THE INTERNET TIMES — CLIENT TYPES
 * ================================
 *
 * The pricing and geometry types are *imported* from `shared/`, not copied. They
 * are the same types the server uses to compute the amount it charges, and a
 * second hand-maintained copy of `Quote` in the browser would eventually drift
 * from the one that decides what people pay. Everything below is only the shape
 * of the HTTP responses in `server/routes.ts`.
 *
 * COORDINATES
 * -----------
 * Everything here is in *logical newspaper pixels* — integers from 0 to
 * pageWidth/pageHeight. Percentages exist only inside components, for CSS. The
 * server validates and prices integers, so integers are the only truth; a
 * percentage that has been through a float round-trip is not something you can
 * charge money for.
 */

import type { PricingConfig, PricingTier } from '../shared/pricing-config.ts';
import type { PriceMapCell, Quote, Rect } from '../shared/pricing.ts';

export type { PriceMapCell, PricingConfig, PricingTier, Quote, Rect };

/** GET /api/config */
export interface SiteConfig {
  pricing: PricingConfig;
  priceMap: PriceMapCell[];
  stripePublishableKey: string | null;
  readiness: {
    database: boolean;
    stripe: boolean;
    webhook: boolean;
    testMode: boolean;
  };
}

/**
 * An area that cannot be selected.
 *
 * 'paid' is permanent. 'pending' is somebody else's checkout in progress, held
 * for a few minutes and then released automatically if they never pay.
 */
export interface OccupiedArea extends Rect {
  pageNumber: number;
  status: 'paid' | 'pending';
}

/**
 * A live advertisement. Only paid bookings ever appear here, and the response
 * carries no price — what somebody paid is not public.
 */
export interface PlacedAd extends Rect {
  bookingId: string;
  pageNumber: number;
  pixelCount: number;
  brandName: string;
  headline: string;
  description: string;
  destinationUrl: string;
  imageUrl: string;
  ctaText: string;
  claimedAt: string | null;
}

export interface NewspaperStats {
  paidBookings: number;
  claimedPixels: number;
  totalPixels: number;
}

/** GET /api/newspaper */
export interface NewspaperState {
  occupied: OccupiedArea[];
  ads: PlacedAd[];
  stats: NewspaperStats;
}

/** What the reader is currently dragging out, plus its price. */
export interface PixelSelection extends Rect {
  pageNumber: number;
  quote: Quote;
  /**
   * True once POST /api/quote has confirmed this exact rectangle. The client's
   * own overlap check is a courtesy so the cursor behaves; only the server
   * decides availability, and only at checkout does that decision bind.
   */
  serverConfirmed: boolean;
}

export interface Conflict extends Rect {
  status: 'pending' | 'paid' | 'cancelled';
}

/** POST /api/quote */
export interface QuoteResponse {
  quote: Quote;
  /** null when the server has no database and therefore cannot know. */
  available: boolean | null;
  conflict?: Conflict;
}

/** The advertisement a buyer is composing. */
export interface AdDraft {
  brandName: string;
  headline: string;
  description: string;
  destinationUrl: string;
  imageUrl: string;
  ctaText: string;
  buyerEmail: string;
}

/** POST /api/checkout */
export interface CheckoutResponse {
  bookingId: string;
  checkoutUrl: string;
  sessionId: string;
  quote: Quote;
}

export interface AdContent {
  brandName: string;
  headline: string;
  description: string;
  destinationUrl: string;
  imageUrl: string;
  ctaText: string;
}

/** GET /api/checkout/status */
export interface CheckoutStatus {
  status: 'pending' | 'paid' | 'cancelled';
  booking: {
    id: string;
    pageNumber: number;
    x: number;
    y: number;
    width: number;
    height: number;
    pixelCount: number;
    /** null until the webhook has confirmed the payment. */
    amountPaid: number | null;
    currency: string;
    claimedAt: string | null;
  };
  ad: AdContent | null;
}

/** GET /api/spaces/:id — a shared link. Paid bookings only, and no price. */
export interface SpaceResponse {
  booking: Rect & {
    id: string;
    pageNumber: number;
    pixelCount: number;
    claimedAt: string | null;
  };
  ad: AdContent | null;
}

export interface FieldError {
  field: string;
  message: string;
}

/** An error the API returned, carrying the machine-readable code with it. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly conflict?: Conflict;
  readonly fields?: FieldError[];

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: { conflict?: Conflict; fields?: FieldError[] }
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.conflict = extra?.conflict;
    this.fields = extra?.fields;
  }
}
