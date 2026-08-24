/**
 * THE INTERNET TIMES — API CLIENT
 * ==============================
 *
 * The only place in the browser bundle that talks to the server. Everything the
 * interface knows about bookings, prices and availability arrives through one of
 * these six functions.
 *
 * WHAT THIS FILE DELIBERATELY CANNOT DO
 * -------------------------------------
 * There is no `markPaid`, no `claim`, and no `setAvailable`. Those are not
 * missing by oversight — the server has no such endpoint. A booking becomes paid
 * only when Stripe's signed webhook says so, and an area is free only when a
 * locked database transaction says so. The most this file can do is *ask*.
 *
 * Prices are likewise only ever read. `postQuote` and `postCheckout` send
 * coordinates; the amount comes back. Sending a price would be pointless because
 * the server ignores any it finds in a request body.
 */

import type {
  AdDraft,
  CheckoutResponse,
  CheckoutStatus,
  Conflict,
  FieldError,
  NewspaperState,
  QuoteResponse,
  Rect,
  SiteConfig,
  SpaceResponse,
} from '../types.ts';
import { ApiError } from '../types.ts';

const BASE = '/api';

interface ErrorBody {
  error?: string;
  message?: string;
  conflict?: Conflict;
  fields?: FieldError[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    });
  } catch {
    // Offline, server down, or the dev server restarting mid-request.
    throw new ApiError(0, 'network', 'Could not reach the newspaper. Check your connection.');
  }

  const text = await response.text();
  let body: unknown = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const err = (body ?? {}) as ErrorBody;
    throw new ApiError(
      response.status,
      err.error ?? 'server-error',
      err.message ?? `Request failed (${response.status}).`,
      { conflict: err.conflict, fields: err.fields }
    );
  }

  return body as T;
}

/** Pricing rules, the price map, and which credentials the server actually has. */
export function fetchConfig(): Promise<SiteConfig> {
  return request<SiteConfig>('/config');
}

/** Occupied areas, live advertisements, and claimed-pixel totals. */
export function fetchNewspaper(): Promise<NewspaperState> {
  return request<NewspaperState>('/newspaper');
}

/**
 * The authoritative price for a rectangle, and whether it is actually free.
 *
 * The client computes the same figure locally while dragging so the number moves
 * with the cursor, then calls this on release and replaces its own answer with
 * this one. They should always agree — both run `shared/pricing.ts` — but this
 * is the one that will be charged.
 */
export function postQuote(pageNumber: number, rect: Rect): Promise<QuoteResponse> {
  return request<QuoteResponse>('/quote', {
    method: 'POST',
    body: JSON.stringify({ pageNumber, ...rect }),
  });
}

/**
 * Start a purchase. Returns the Stripe Checkout URL to redirect to.
 *
 * Note what is *not* in the request: no price. The server prices the rectangle
 * itself and creates the session for that amount.
 */
export function postCheckout(payload: {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  ad: AdDraft;
}): Promise<CheckoutResponse> {
  const { ad, ...rect } = payload;

  // The ad fields go on the top level of the body because that is where
  // `validateAdSubmission` reads them from. Flattening happens here, once, rather
  // than every caller having to remember the wire shape.
  return request<CheckoutResponse>('/checkout', {
    method: 'POST',
    body: JSON.stringify({ ...rect, ...ad }),
  });
}

/**
 * Ask whether the webhook has confirmed a payment yet.
 *
 * Polled after Stripe sends the buyer back. Reloading the page a hundred times
 * cannot turn a 'pending' into a 'paid'; this only reports what the database
 * already holds.
 */
export function fetchCheckoutStatus(sessionId: string): Promise<CheckoutStatus> {
  return request<CheckoutStatus>(`/checkout/status?session_id=${encodeURIComponent(sessionId)}`);
}

/** A single claimed space, for the shareable link. Paid bookings only. */
export function fetchSpace(bookingId: string): Promise<SpaceResponse> {
  return request<SpaceResponse>(`/spaces/${encodeURIComponent(bookingId)}`);
}
