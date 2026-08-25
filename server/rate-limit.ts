/**
 * PIXEL PAPER — RATE LIMITING (ANTI-SPAM)
 * =============================================
 *
 * A small, in-memory, per-IP rate limiter for the submission endpoint. No Redis,
 * no external service, no new dependency — the same hand-rolled, dependency-free
 * spirit as the rest of the server. State lives in a `Map` and resets when the
 * process restarts, which is an acceptable trade for "practical anti-spam": it
 * blunts a flood from one source without pretending to be distributed infrastructure.
 *
 * WHAT IT PROTECTS, AND WHAT IT DOES NOT
 * --------------------------------------
 * It caps how many times a single client IP may hit `POST /api/checkout` in a
 * window. It does NOT touch `/api/quote` (called on every drag, by design) or any
 * read route. The client IP is read from `x-forwarded-for` (the header Render and
 * other proxies set), falling back to the socket address — the same
 * proxy-header-first approach `resolveBaseUrl` already uses. That header is
 * client-influenced, so a determined attacker rotating it can evade the cap; this
 * is best-effort by design, which is exactly what the requirement asks for. A
 * stricter setup would configure Express `trust proxy` and use `req.ip`, but that
 * is a server-wide behaviour change and is intentionally left alone here.
 *
 * LOOPBACK IS EXEMPT
 * ------------------
 * Requests from loopback are never limited. That is the app talking to itself —
 * the acceptance test drives a burst of checkouts from localhost, and the operator
 * may too — the same "localhost is trusted for self-testing" stance the URL rules
 * take. A real remote abuser never appears as loopback once `x-forwarded-for` is
 * read.
 */

import type { Request } from 'express';

export interface RateLimitResult {
  /** True when the request may proceed. */
  allowed: boolean;
  /** Seconds until the caller should try again. 0 when allowed. */
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

export interface RateLimiterOptions {
  /** Rolling window length, in milliseconds. */
  windowMs: number;
  /** Most requests permitted per key within the window. */
  max: number;
  /** When true (the default), loopback keys are never limited. */
  exemptLoopback?: boolean;
}

/** A cap on distinct keys held at once, so a spoofed-IP flood cannot grow the map without bound. */
const MAX_KEYS = 10_000;

/** Is this address loopback, in any of the spellings Node hands us? */
export function isLoopback(ip: string): boolean {
  const host = ip.toLowerCase();
  return (
    host === '::1' ||
    host === '::ffff:127.0.0.1' ||
    host.startsWith('127.') ||
    host.startsWith('::ffff:127.')
  );
}

function normalizeIp(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * The client's IP, proxy-header first.
 *
 * Uses the first hop of `x-forwarded-for` — the same convention `resolveBaseUrl`
 * uses for the forwarded host/proto — then the raw socket address. Returns
 * `'unknown'` only if neither is present, so a missing address collapses to a
 * single shared bucket rather than slipping the limiter entirely.
 */
export function clientIp(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return normalizeIp(forwarded);

  const socket = req.socket?.remoteAddress || '';
  return normalizeIp(socket) || 'unknown';
}

/** Drop keys whose most recent hit has fallen out of the window; then enforce the size cap. */
function prune(hits: Map<string, number[]>, cutoff: number): void {
  for (const [key, times] of hits) {
    if (times.length === 0 || times[times.length - 1] <= cutoff) hits.delete(key);
  }

  if (hits.size <= MAX_KEYS) return;

  // Still over cap (many live keys): evict the least-recently-active first.
  const byRecency = [...hits.entries()].sort(
    (a, b) => a[1][a[1].length - 1] - b[1][b[1].length - 1]
  );
  for (const [key] of byRecency) {
    if (hits.size <= MAX_KEYS) break;
    hits.delete(key);
  }
}

/**
 * Build a rate limiter. Each returned `check(key)` records the call and reports
 * whether the key is now over its limit within the rolling window.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, max, exemptLoopback = true } = options;
  const hits = new Map<string, number[]>();

  function check(key: string): RateLimitResult {
    if (exemptLoopback && isLoopback(key)) return { allowed: true, retryAfterSec: 0 };

    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= max) {
      hits.set(key, recent);
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      prune(hits, cutoff);
      return { allowed: false, retryAfterSec };
    }

    recent.push(now);
    hits.set(key, recent);
    if (hits.size > MAX_KEYS) prune(hits, cutoff);

    return { allowed: true, retryAfterSec: 0 };
  }

  return { check };
}
