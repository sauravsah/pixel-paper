/** Anonymous first-party visitor identity for the presence counter. */

import { randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';

const VISITOR_COOKIE = 'pp_visitor';
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readCookie(header: string | undefined): string | null {
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    const name = part.slice(0, separator).trim();
    if (name !== VISITOR_COOKIE) continue;

    try {
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      return UUID_PATTERN.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  return null;
}

/** Return the existing anonymous id, or issue a hardened first-party cookie. */
export function ensureVisitorId(req: Request, res: Response): string {
  const existing = readCookie(req.headers.cookie);
  if (existing) return existing;

  const visitorId = randomUUID();
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure = req.secure || forwardedProto === 'https';
  const secureAttribute = secure ? '; Secure' : '';

  res.setHeader(
    'Set-Cookie',
    `${VISITOR_COOKIE}=${visitorId}; Max-Age=${VISITOR_COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secureAttribute}`
  );

  return visitorId;
}
