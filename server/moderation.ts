/**
 * PIXEL PAPER — CONTENT & DESTINATION MODERATION
 * ====================================================
 *
 * `validateAdSubmission` (server/validation.ts) decides whether a submission is
 * the right *shape*: fields present, within length, a syntactically safe http/https
 * link, a bounded image. This module decides the next question, which is a matter
 * of policy rather than shape:
 *
 *     Given a well-formed submission, is it safe to publish on a page strangers
 *     read and click?
 *
 * It runs on the server only, after validation has passed, and returns the same
 * `FieldError[]` shape validation uses — so a rejection here reaches the browser
 * through the exact response the form already knows how to display. An empty array
 * means "nothing to object to".
 *
 * WHY THIS IS SEPARATE FROM parseSafeUrl
 * --------------------------------------
 * `parseSafeUrl` is shared with the browser and answers "is this a safe http/https
 * URL?". It deliberately accepts `localhost` and private addresses so the app can
 * be pointed at itself during development. That is the right answer for a *syntax*
 * check. Whether a *public billboard* may link to a loopback, private, or
 * cloud-metadata address is a different question with a different answer, and it
 * belongs here, in the server's publish-time policy — not in the shared parser,
 * where tightening it would break local testing and its tests. Keeping the two
 * apart is what lets each stay correct.
 *
 * WHAT IS CHECKED
 * ---------------
 *   1. Destination host — refuse loopback / private / link-local / cloud-metadata /
 *      reserved addresses, embedded credentials, and internal-only name suffixes.
 *   2. Destination reputation — refuse blocked domains and blocked keywords.
 *   3. Image host — the same host rules, for a hosted http(s) image. An attached
 *      `data:image` never touches the network and is left to `parseSafeImageSrc`.
 *   4. Markup / script in the text fields — refuse stored HTML, event handlers and
 *      script URLs. React escapes on render, so this is defence in depth: it keeps
 *      an attack payload from ever being *stored*, where a future non-React surface,
 *      an API consumer, an export or a log would re-emit it unescaped.
 */

import type { FieldError } from './validation.ts';
import { BLOCKED_DOMAINS, BLOCKED_KEYWORDS } from './moderation-lists.ts';

/** The already-validated, normalised creative handed to moderation. */
export interface ModeratedAd {
  brandName: string;
  headline: string;
  description: string;
  destinationUrl: string;
  imageUrl: string;
  ctaText: string;
}

/** Friendly labels for the text fields, used only in rejection copy. */
const FIELD_LABELS: Record<string, string> = {
  brandName: 'brand name',
  headline: 'headline',
  description: 'description',
  ctaText: 'button text',
};

// ---------------------------------------------------------------------------
// Host classification
//
// The destination string reaching this module is the output of `parseSafeUrl`,
// so it re-parses cleanly and its host is already normalised: odd IPv4 spellings
// (octal, hex, packed integer) have been folded to dotted-decimal, and IPv6 to its
// canonical bracketed form. We classify that normalised host.
// ---------------------------------------------------------------------------

/** Dotted-decimal IPv4 → its four octets, or null if the host is not IPv4. */
function ipv4Octets(host: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const octets = host.split('.').map(Number);
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/**
 * Is this IPv4 address one a public advertisement must never point at?
 *
 * Covers loopback, the three private ranges, link-local (which includes the cloud
 * metadata address 169.254.169.254), carrier-grade NAT, "this network", the
 * documentation/test ranges, and everything from multicast upward — none of which
 * is ever a real, reachable, public web destination.
 */
function isBlockedIpv4([a, b]: number[]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF + 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

/**
 * Is this IPv6 literal (already stripped of its brackets) a non-public address?
 *
 * Handles the forms that actually occur — loopback, unspecified, unique-local and
 * link-local — plus IPv4-mapped addresses, whose embedded IPv4 is run through the
 * IPv4 rules above. Ordinary global IPv6 is allowed; a public site reached by a
 * bare IPv6 literal is unusual but legitimate.
 */
function isBlockedIpv6(literal: string): boolean {
  const ip = literal.toLowerCase();

  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  if (/^f[cd]/.test(ip)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local

  // IPv4-mapped (::ffff:a.b.c.d, or the same folded to ::ffff:hhhh:hhhh).
  const mapped = /^::ffff:(.+)$/.exec(ip);
  if (mapped) {
    const tail = mapped[1];
    const asV4 = ipv4Octets(tail);
    if (asV4) return isBlockedIpv4(asV4);

    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isBlockedIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
    }
  }

  return false;
}

/** Internal-only name suffixes that resolve nowhere a stranger could follow. */
const INTERNAL_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.home.arpa', '.intranet'];

/**
 * Would this host make a bad public destination on grounds of *where it points*
 * (as opposed to reputation)? True for loopback/private/reserved addresses and
 * internal-only names.
 */
function isUnsafeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host === 'localhost') return true;
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  if (host.startsWith('[') && host.endsWith(']')) {
    return isBlockedIpv6(host.slice(1, -1));
  }

  const octets = ipv4Octets(host);
  if (octets) return isBlockedIpv4(octets);

  return false;
}

// ---------------------------------------------------------------------------
// Reputation matching
// ---------------------------------------------------------------------------

/** Does `host` equal a blocked domain, or sit beneath one? */
function isBlockedDomain(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  for (const domain of BLOCKED_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * A word-boundary test for one blocked keyword. Separators common in URLs and
 * copy (dot, slash, dash, underscore) count as boundaries, so a keyword is caught
 * inside a host or path but not inside an unrelated longer word.
 */
function keywordHit(haystack: string, keyword: string): boolean {
  const flattened = haystack.toLowerCase().replace(/[._/\-]+/g, ' ');
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(flattened);
}

function firstBlockedKeyword(haystack: string): string | null {
  for (const keyword of BLOCKED_KEYWORDS) {
    if (keywordHit(haystack, keyword)) return keyword;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markup / script screening for text fields
// ---------------------------------------------------------------------------

const HTML_TAG = /<\s*\/?\s*[a-z!?]/i; // <a … </div … <!-- … <?xml
const EVENT_HANDLER = /\bon[a-z]+\s*=/i; // onerror= onload= onclick=
const SCRIPT_SCHEME = /(?:javascript|vbscript)\s*:/i; // javascript: vbscript:

/**
 * Does this text carry markup, an inline event handler, or a script URL?
 *
 * `data:` is intentionally NOT flagged here: it is only dangerous in a URL slot
 * (href/src), which `parseSafeUrl`/`parseSafeImageSrc` already govern, and a
 * headline like "Big data: the sequel" is perfectly innocent text.
 */
function looksLikeMarkup(text: string): boolean {
  return HTML_TAG.test(text) || EVENT_HANDLER.test(text) || SCRIPT_SCHEME.test(text);
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Screen an already-validated advertisement for unsafe destinations and content.
 *
 * Returns a list of problems in the same `{field, message}` shape as validation,
 * empty when the ad is clean. Messages are deliberately non-specific about the
 * lists themselves — they tell a buyer what to change without handing an abuser a
 * map of exactly what is filtered.
 */
export function moderateAdSubmission(ad: ModeratedAd): FieldError[] {
  const errors: FieldError[] = [];

  // 1 + 2. Destination: host safety, then reputation. Parsing cannot fail — this
  // string already passed parseSafeUrl — but we stay defensive rather than assume.
  let destUrl: URL | null = null;
  try {
    destUrl = new URL(ad.destinationUrl);
  } catch {
    destUrl = null;
  }

  if (destUrl) {
    if (destUrl.username || destUrl.password) {
      errors.push({
        field: 'destinationUrl',
        message: 'Remove the username and password from the link, then use a plain https:// address.',
      });
    } else if (isUnsafeHost(destUrl.hostname)) {
      errors.push({
        field: 'destinationUrl',
        message: 'That link points to a private or local address. Use a public http(s) web address.',
      });
    } else if (isBlockedDomain(destUrl.hostname)) {
      errors.push({
        field: 'destinationUrl',
        message: 'That destination is not allowed on the page. Please link somewhere else.',
      });
    } else {
      const hit = firstBlockedKeyword(`${destUrl.hostname}${destUrl.pathname}${destUrl.search}`);
      if (hit) {
        errors.push({
          field: 'destinationUrl',
          message: 'That destination is not allowed on the page. Please link somewhere else.',
        });
      }
    }
  }

  // 3. Hosted image host — only when the image is an http(s) address. A bounded
  // data:image carries no host and never hits the network, so it is exempt.
  if (ad.imageUrl && /^https?:/i.test(ad.imageUrl)) {
    let imgUrl: URL | null = null;
    try {
      imgUrl = new URL(ad.imageUrl);
    } catch {
      imgUrl = null;
    }
    if (imgUrl && (imgUrl.username || imgUrl.password || isUnsafeHost(imgUrl.hostname) || isBlockedDomain(imgUrl.hostname))) {
      errors.push({
        field: 'imageUrl',
        message: 'That image address is not allowed. Host the image on a public site, or attach a file instead.',
      });
    }
  }

  // 4. Markup / script in the visible text, plus a keyword sweep of the same copy.
  const textFields: Array<[keyof ModeratedAd, string]> = [
    ['brandName', ad.brandName],
    ['headline', ad.headline],
    ['description', ad.description],
    ['ctaText', ad.ctaText],
  ];

  for (const [field, value] of textFields) {
    if (!value) continue;
    if (looksLikeMarkup(value)) {
      errors.push({
        field,
        message: `The ${FIELD_LABELS[field] ?? field} can't contain HTML or script. Use plain text.`,
      });
      continue; // one problem per field is enough to send it back
    }
    if (firstBlockedKeyword(value)) {
      errors.push({
        field,
        message: `The ${FIELD_LABELS[field] ?? field} contains a word that isn't allowed on the page.`,
      });
    }
  }

  return errors;
}
