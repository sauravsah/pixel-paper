/**
 * PIXEL PAPER — INPUT VALIDATION
 * =====================================
 *
 * Everything a buyer types is validated here before it reaches the database or
 * the payment provider. Nothing is trusted for having come from our own form.
 *
 * The rules themselves — how long a headline may be, what a usable web address
 * looks like, what an email looks like — live in `shared/field-rules.ts`, because
 * the booking form needs to apply the same rules to give someone feedback while
 * they are still typing. This module is where those rules become an HTTP answer:
 * which field was wrong, and what to say about it.
 *
 * The form checking a field and this function checking it are not redundant. The
 * form's copy is a courtesy that any caller can skip entirely by posting to the
 * API directly. This one is the decision.
 */

import {
  MAX_LENGTHS,
  asString,
  isValidEmail,
  parseSafeImageSrc,
  parseSafeUrl,
  tidy,
} from '../shared/field-rules.ts';

// Re-exported so callers already validating through this module keep working,
// rather than reaching across into `shared/` for a single predicate.
export { isValidEmail, parseSafeUrl };

export interface FieldError {
  field: string;
  message: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

export interface AdSubmission {
  brandName: string;
  headline: string;
  description: string;
  destinationUrl: string;
  imageUrl: string;
  ctaText: string;
  buyerEmail: string | null;
}

/**
 * Validate the advertisement half of a checkout request.
 *
 * A destination URL is always required. Beyond that an ad takes one of two
 * shapes: an ordinary one, which needs a brand name and a headline, or a
 * logo-only one, which needs neither because it is just an image that links
 * somewhere. So brand name and headline are required only when no image is
 * given; everything else is optional and normalises to an empty string. All
 * errors are collected so the form can show every problem at once instead of one
 * per round trip.
 */
export function validateAdSubmission(body: Record<string, unknown>): Validated<AdSubmission> {
  const errors: FieldError[] = [];

  const brandName = tidy(body.brandName);
  const headline = tidy(body.headline);
  const description = tidy(body.description);
  const ctaText = tidy(body.ctaText);

  // Parsed first, because whether brand and headline are required depends on it:
  // a logo-only ad is just an image that links somewhere, with no text at all. The
  // image may be a hosted http/https address or a file the buyer attached, which
  // reaches us as a bounded data:image URL.
  let imageUrl = '';
  const rawImage = asString(body.imageUrl).trim();
  if (rawImage) {
    const parsed = parseSafeImageSrc(rawImage);
    if (!parsed) {
      errors.push({
        field: 'imageUrl',
        message: 'The image must be a PNG, JPEG, GIF, WEBP or SVG file under 1 MB.',
      });
    } else {
      imageUrl = parsed;
    }
  }
  const hasImage = imageUrl.length > 0;

  // Brand and headline carry an ordinary ad. With an image present the ad can be
  // logo-only, so they become optional — but a value that is given is still held
  // to its length limit.
  if (brandName.length > MAX_LENGTHS.brandName) {
    errors.push({
      field: 'brandName',
      message: `Keep the name to ${MAX_LENGTHS.brandName} characters or fewer.`,
    });
  } else if (!brandName && !hasImage) {
    errors.push({ field: 'brandName', message: 'Add the name that should appear on the page.' });
  }

  if (headline.length > MAX_LENGTHS.headline) {
    errors.push({
      field: 'headline',
      message: `Keep the headline to ${MAX_LENGTHS.headline} characters or fewer.`,
    });
  } else if (!headline && !hasImage) {
    errors.push({ field: 'headline', message: 'Add a headline, or add a logo image instead.' });
  }

  if (description.length > MAX_LENGTHS.description) {
    errors.push({
      field: 'description',
      message: `Keep the description to ${MAX_LENGTHS.description} characters or fewer.`,
    });
  }

  if (ctaText.length > MAX_LENGTHS.ctaText) {
    errors.push({
      field: 'ctaText',
      message: `Keep the button text to ${MAX_LENGTHS.ctaText} characters or fewer.`,
    });
  }

  const destinationUrl = parseSafeUrl(body.destinationUrl);
  if (!destinationUrl) {
    errors.push({
      field: 'destinationUrl',
      message: 'Add the web address your space should link to (http or https).',
    });
  }

  let buyerEmail: string | null = null;
  const rawEmail = asString(body.buyerEmail).trim();
  if (rawEmail) {
    if (!isValidEmail(rawEmail)) {
      errors.push({ field: 'buyerEmail', message: 'That email address does not look right.' });
    } else {
      buyerEmail = rawEmail.toLowerCase();
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      brandName,
      headline,
      description,
      destinationUrl: destinationUrl as string,
      imageUrl,
      ctaText,
      buyerEmail,
    },
  };
}
