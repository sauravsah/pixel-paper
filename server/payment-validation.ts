/**
 * Server-side policy for provider payment amounts and discounts.
 *
 * These helpers only consume data that has already passed webhook signature
 * verification. They intentionally do not accept client-supplied price or
 * discount fields.
 */

export interface ProviderDiscountRecord {
  discount_id?: unknown;
  type?: unknown;
  amount?: unknown;
  restricted_to?: unknown;
  starts_at?: unknown;
  expires_at?: unknown;
}

export interface ProviderPaymentExpectations {
  currency: string;
  productId: string;
  checkoutSessionId: string;
}

/** Validate the provider facts that must accompany a successful payment event. */
export function isProviderPaymentValid(
  data: Record<string, unknown>,
  expected: ProviderPaymentExpectations
): boolean {
  if (data.status !== 'succeeded') return false;

  const currency = typeof data.currency === 'string' ? data.currency.toLowerCase() : '';
  if (!currency || currency !== expected.currency.toLowerCase()) return false;

  if (typeof data.payment_id !== 'string' || data.payment_id.length === 0) return false;
  if (data.checkout_session_id !== expected.checkoutSessionId) return false;

  if (!Array.isArray(data.product_cart) || data.product_cart.length === 0) return false;
  return data.product_cart.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const product = item as { product_id?: unknown; quantity?: unknown };
    return product.product_id === expected.productId
      && product.quantity === 1;
  });
}

/** A provider lookup failed in a way that should cause webhook retry. */
export class TransientProviderLookupError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('Temporary provider lookup failure.');
    this.name = 'TransientProviderLookupError';
    this.cause = cause;
  }
}

function isFullPercentageDiscount(
  value: unknown,
  productId: string,
  expectedDiscountId: string,
  paymentTimeMs: number
): value is ProviderDiscountRecord {
  if (!value || typeof value !== 'object') return false;

  const discount = value as ProviderDiscountRecord;
  if (
    typeof discount.discount_id !== 'string' ||
    discount.discount_id.length === 0 ||
    discount.discount_id !== expectedDiscountId ||
    discount.type !== 'percentage' ||
    typeof discount.amount !== 'number' ||
    discount.amount !== 10_000
  ) {
    return false;
  }

  const startsAt = parseProviderDate(discount.starts_at);
  const expiresAt = parseProviderDate(discount.expires_at);
  if (Number.isNaN(startsAt) || Number.isNaN(expiresAt)) return false;
  if (!Number.isFinite(paymentTimeMs)) return false;
  if (
    (startsAt !== null && startsAt > paymentTimeMs) ||
    (expiresAt !== null && expiresAt <= paymentTimeMs)
  ) {
    return false;
  }

  // An empty restriction means the provider considers the discount global.
  // Otherwise the signed discount must explicitly include this product.
  return (
    Array.isArray(discount.restricted_to) &&
    (discount.restricted_to.length === 0 || discount.restricted_to.includes(productId))
  );
}

function parseProviderDate(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return Number.NaN;

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Check complete discount details included in a verified provider payload.
 * `discount_id` alone is only an identifier, not proof of a 100% discount.
 */
export function hasValidFullDiscountEvidence(
  data: Record<string, unknown>,
  productId: string,
  paymentTimeMs: number
): boolean {
  if (!productId || !Array.isArray(data.discounts)) return false;

  const topLevelId =
    typeof data.discount_id === 'string' && data.discount_id.length > 0
      ? data.discount_id
      : null;
  if (!topLevelId) return false;

  return data.discounts.some((discount) => {
    return isFullPercentageDiscount(discount, productId, topLevelId, paymentTimeMs);
  });
}

/**
 * Verify a zero-value payment using either complete signed discount details or
 * a server-side lookup of the signed legacy discount id. Invalid provider data
 * returns false; transient lookup failures are deliberately allowed to throw so
 * the webhook can release its idempotency claim and ask the provider to retry.
 */
export async function hasVerifiedFullDiscountEvidence(
  data: Record<string, unknown>,
  productId: string,
  retrieveDiscount: (discountId: string) => Promise<unknown>,
  paymentTimeMs: number
): Promise<boolean> {
  if (hasValidFullDiscountEvidence(data, productId, paymentTimeMs)) return true;

  const discountId =
    typeof data.discount_id === 'string' && data.discount_id.length > 0
      ? data.discount_id
      : null;
  if (!productId || !discountId || !Number.isFinite(paymentTimeMs)) return false;

  return isFullPercentageDiscount(
    await retrieveDiscount(discountId),
    productId,
    discountId,
    paymentTimeMs
  );
}

export interface RecordedPaymentAmounts {
  originalAmountCents: number;
  actualAmountCents: number;
  discountAmountCents: number;
}

/**
 * Keep list price on the booking while recording the amount actually collected
 * on the order. In V1, the only supported discount is a verified 100% discount.
 */
export function paymentAmountsForOrder(
  originalAmountCents: number,
  validFullDiscount: boolean
): RecordedPaymentAmounts {
  if (!Number.isInteger(originalAmountCents) || originalAmountCents < 0) {
    throw new Error('Invalid original payment amount.');
  }

  const actualAmountCents = validFullDiscount ? 0 : originalAmountCents;
  return {
    originalAmountCents,
    actualAmountCents,
    discountAmountCents: originalAmountCents - actualAmountCents,
  };
}

/**
 * Preserve the existing minimum amount rule, with one explicit exception for
 * a provider-verified 100% discount. Dodo may add tax, so overages remain valid.
 */
export function isProviderAmountAcceptable(
  expectedAmountCents: number,
  receivedAmountCents: number,
  validFullDiscount: boolean
): boolean {
  if (!Number.isInteger(expectedAmountCents) || expectedAmountCents < 0) return false;
  if (!Number.isSafeInteger(receivedAmountCents) || receivedAmountCents < 0) return false;
  if (receivedAmountCents === 0) return validFullDiscount;
  return receivedAmountCents >= expectedAmountCents;
}
