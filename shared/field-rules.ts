/**
 * FIELD RULES — SHARED BY THE SERVER AND THE BROWSER
 * ==================================================
 *
 * The rules for what counts as an acceptable brand name, headline, web address
 * and email. Pure text handling, no dependencies, so the same code runs in Node
 * and in the browser.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED
 * -------------------------------------
 * The form wants to tell someone their link looks wrong while they are still
 * looking at the field. The server has to decide the same question before it will
 * write anything down. Those are two different jobs with one right answer, and
 * two implementations of one right answer drift — usually in the direction where
 * the form accepts something the server then rejects at the last moment, after
 * the buyer has already filled everything in.
 *
 * The browser uses these as a courtesy. The server uses them as the decision.
 * Nothing the browser concludes here is trusted: `validateAdSubmission` in
 * `server/validation.ts` runs the same functions again on the request body and
 * that run is the one that counts.
 *
 * URL HANDLING
 * ------------
 * Buyer-supplied addresses end up in `href` and `src` attributes on a page
 * strangers read, so `parseSafeUrl` accepts only http and https. A
 * `javascript:alert(1)` destination would be a stored cross-site scripting hole
 * that fires for every visitor, and `data:text/html,...` is the same hole wearing
 * a different hat. Both are rejected outright rather than sanitised, because a
 * rejected address is unambiguous and a sanitised one is a guess. The destination
 * link is always held to this rule.
 *
 * The image is the one exception, handled by the separate `parseSafeImageSrc`. As
 * well as a hosted http/https address, a buyer may attach a file from their device,
 * which arrives as a `data:image/…;base64,…` URL. That is accepted only for an
 * allow-listed image media type and only up to `MAX_IMAGE_BYTES` once decoded. It
 * is safe where `data:text/html` is not: a `data:image` set as an `<img src>` is
 * loaded as an image document, which the browser runs with scripting disabled —
 * true even for SVG — and this app never inlines that markup into the DOM, it only
 * ever points an `<img>` at it.
 */

export const MAX_LENGTHS = {
  brandName: 60,
  headline: 120,
  description: 400,
  ctaText: 28,
  url: 2048,
  email: 254,
} as const;

/**
 * The largest image we will embed directly in an ad, before base64 encoding. An
 * attachment travels inside the checkout request body AND inside the page payload
 * every reader downloads afterwards, so it is capped rather than open-ended:
 * generous enough for a logo or a modest photo, without turning every page load
 * into a multi-megabyte download. Anything larger should be hosted and linked.
 *
 * Two limits move with this one: the client's `file.size` pre-check and, on the
 * server, `express.json`'s body limit (which is set to `MAX_IMAGE_BYTES * 2` in
 * `server.ts` — base64 inflates the bytes by ~4/3, plus the rest of the form).
 */
export const MAX_IMAGE_BYTES = 1024 * 1024;

/** Protocols permitted in any buyer-supplied URL. Nothing else, ever. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * Collapse whitespace and strip control characters.
 *
 * Control characters are removed because they are invisible in the form yet can
 * break out of the JSON and CSS contexts this text later lands in.
 */
export function tidy(value: unknown): string {
  return asString(value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a buyer-supplied URL, or return null.
 *
 * A bare `example.com` is upgraded to `https://example.com`, which is what
 * someone typing a domain into a form means. Anything whose protocol is not
 * http or https is rejected.
 */
export function parseSafeUrl(raw: unknown): string | null {
  // Strings only. A number would sail through `new URL` in a surprising way —
  // `https://42` normalises to `https://0.0.0.42/`, because a bare integer is
  // read as a packed IPv4 address. Nobody typing a link means that.
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LENGTHS.url) return null;

  // Reject control characters and whitespace outright: they are used to smuggle
  // a disallowed protocol past a naive parser, e.g. "java\nscript:".
  if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) return null;

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;

  if (!isPlausibleHostname(url.hostname)) return null;

  return url.toString();
}

/**
 * Image media types we accept as an embedded attachment. All are safe to set as
 * an `<img src>`: the browser loads an image document with scripting disabled,
 * even for SVG, and this app never inlines the markup elsewhere.
 */
const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

/** `data:<mediatype>;base64,<payload>`, with a well-formed base64 payload. */
const DATA_IMAGE_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

/**
 * Parse a buyer-supplied image source, or return null.
 *
 * Two shapes are accepted. A hosted image goes through the same `parseSafeUrl`
 * rule as any other address. An attachment the buyer picked from their device
 * arrives as a `data:image/…;base64,…` URL; that is accepted only for an
 * allow-listed image media type and only up to `MAX_IMAGE_BYTES` once decoded.
 * Anything else — a `data:text/html` payload, an oversize file, malformed base64 —
 * is rejected, so the one relaxation over `parseSafeUrl` stays narrow.
 */
export function parseSafeImageSrc(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^data:/i.test(trimmed)) {
    const match = DATA_IMAGE_RE.exec(trimmed);
    if (!match) return null;

    const mediaType = match[1].toLowerCase();
    if (!ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) return null;

    // Canonical base64 is whole 4-character groups; the padding says how many
    // bytes the final group really carries, which is all we need to size it.
    const payload = match[2];
    if (payload.length === 0 || payload.length % 4 !== 0) return null;
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    const byteLength = (payload.length / 4) * 3 - padding;
    if (byteLength <= 0 || byteLength > MAX_IMAGE_BYTES) return null;

    return `data:${mediaType};base64,${payload}`;
  }

  return parseSafeUrl(trimmed);
}

/**
 * Does this hostname look like somewhere a reader could actually go?
 *
 * `new URL` is happy with things like `https://.` and `https://-`, which parse
 * cleanly but resolve to nothing. Accepted here: a dotted domain whose labels
 * are well formed and whose top-level label is alphabetic, a bare IPv4 address,
 * a bracketed IPv6 address, or `localhost` for local testing.
 */
function isPlausibleHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;

  if (hostname === 'localhost') return true;

  // IPv6 arrives from `new URL` already wrapped in brackets.
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.length > 2;

  // IPv4.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split('.').every((part) => Number(part) <= 255);
  }

  // A normal domain: one or more labels, then an alphabetic TLD. Labels may
  // contain hyphens but may not begin or end with one.
  return /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname);
}

export function isValidEmail(raw: unknown): boolean {
  const value = asString(raw).trim();
  if (!value || value.length > MAX_LENGTHS.email) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}
