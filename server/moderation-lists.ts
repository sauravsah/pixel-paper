/**
 * PIXEL PAPER — MODERATION LISTS
 * ====================================
 *
 * The block lists behind `moderateAdSubmission` (see `server/moderation.ts`). They
 * are kept in their own module, apart from the matching logic, for one reason: the
 * lists are the part an operator is expected to edit over time, and the matching
 * logic is the part that should not have to change when they do.
 *
 * These are a STARTER set, deliberately small. The point of this file is the
 * mechanism — a maintainable place to name destinations and words that must never
 * run on a public page a stranger reads — not an attempt to enumerate the whole
 * hostile internet, which no hand-kept list can do. Treat it as a policy seed to
 * grow from real reports, not a finished filter.
 *
 * NOTHING HERE IS A SECRET. These lists ship in the client-free server bundle and
 * describe what is *refused*; they contain no credentials and no private data.
 *
 * HOW TO EXTEND
 * -------------
 *   • BLOCKED_DOMAINS — add a registrable domain in lower case, no scheme, no
 *     `www.`, e.g. `'evil.example'`. A blocked domain also blocks every subdomain
 *     of it (`promo.evil.example` is refused when `evil.example` is listed), so
 *     list the parent, not each host.
 *   • BLOCKED_KEYWORDS — add a lower-case word or short phrase. Matching is
 *     whole-word and case-insensitive against the destination host+path and the
 *     ad's own text, so `'sex'` will NOT trip on `'sussex'`. Prefer unambiguous
 *     terms; a word that also appears in innocent copy will reject innocent ads.
 */

/**
 * Registrable domains that may never be an ad's destination or hosted image host.
 * Each entry also covers its subdomains. Lower case, bare domain only.
 *
 * The seed entries are stand-ins for the categories an operator curates from
 * abuse reports — a known malware/phishing host, an obvious NSFW domain, a scam
 * pattern. Replace and grow them with real observations.
 */
export const BLOCKED_DOMAINS: ReadonlySet<string> = new Set([
  // — Malware / phishing (examples; extend from real reports) —
  'malware.testing.google.test',
  'phishing.example',

  // — Adult / NSFW (examples) —
  'pornhub.com',
  'xvideos.com',
  'xnxx.com',
  'onlyfans.com',

  // — Reserved test/documentation names that are never a real destination —
  'example.test',
  'invalid',
]);

/**
 * Words and short phrases that must not appear in a destination host/path or in
 * the ad's own text. Whole-word, case-insensitive. Kept short and unambiguous on
 * purpose — see the false-positive warning above.
 */
export const BLOCKED_KEYWORDS: readonly string[] = [
  // — Adult / NSFW —
  'porn',
  'xxx',
  'nsfw',
  'escort',
  'camgirl',

  // — Illegal / harmful —
  'child porn',
  'cp links',

  // — Malware / fraud lures —
  'malware',
  'ransomware',
  'keylogger',
  'carding',
  'stolen cards',
  'counterfeit',
];
