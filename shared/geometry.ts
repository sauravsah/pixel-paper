/**
 * PIXEL PAPER — GEOMETRY & SELECTION VALIDATION
 * ===================================================
 *
 * Shared by the server and the client so both agree on exactly which pixels a
 * rectangle owns and what counts as a legal selection.
 *
 * PIXEL OWNERSHIP CONVENTION
 * --------------------------
 * A booking at (x, y) with size (width, height) owns the pixels
 *
 *     x .. x + width  - 1     horizontally
 *     y .. y + height - 1     vertically
 *
 * so two rectangles that merely touch edge-to-edge do NOT overlap. A block at
 * x = 0 width 100 (pixels 0-99) sits flush against a block at x = 100
 * (pixels 100-199) and both are perfectly legal. This same half-open rule is
 * mirrored by the PostgreSQL exclusion constraint in the migration, so the
 * database and the application can never disagree about what "overlapping"
 * means.
 */

import type { PricingConfig } from './pricing-config.ts';
import type { Rect } from './pricing.ts';

/** True when two rectangles share at least one pixel. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/** True when the point (px, py) falls inside the rectangle. */
export function pointInRect(rect: Rect, px: number, py: number): boolean {
  return px >= rect.x && px < rect.x + rect.width && py >= rect.y && py < rect.y + rect.height;
}

/** The logical rectangle that may be purchased on every newspaper page. */
export function inventoryRect(config: PricingConfig): Rect {
  return {
    x: 0,
    y: config.inventoryTop,
    width: config.pageWidth,
    height: config.inventoryBottom - config.inventoryTop,
  };
}

/** True when a rectangle is wholly inside the purchasable inventory band. */
export function rectInInventory(config: PricingConfig, rect: Rect): boolean {
  const inventory = inventoryRect(config);
  return (
    rect.x >= inventory.x &&
    rect.y >= inventory.y &&
    rect.x + rect.width <= inventory.x + inventory.width &&
    rect.y + rect.height <= inventory.y + inventory.height
  );
}

/**
 * Strictly coerce an untrusted value to a whole number, or return `null`.
 *
 * Deliberately NOT `Number(value)`. That helper is dangerously permissive on a
 * public endpoint: `Number(null)`, `Number('')`, `Number([])` and
 * `Number(false)` are all `0`, and `Number(true)` is `1`. A client sending
 * `{"x": null}` would silently be priced as `x: 0` — a real rectangle at a real
 * price that the buyer never selected. Only genuine numbers and plainly numeric
 * strings are accepted here; everything else is rejected outright.
 */
function toInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}

export type SelectionError =
  | 'invalid-page'
  | 'non-integer'
  | 'out-of-bounds'
  | 'outside-inventory'
  | 'too-small'
  | 'too-large';

export interface ValidationResult {
  ok: boolean;
  error?: SelectionError;
  message?: string;
  rect?: Rect;
}

/**
 * Validate a selection against the page geometry.
 *
 * The server runs this on every request before it prices or reserves anything,
 * so hand-crafted coordinates from a modified client get rejected rather than
 * silently clamped into something chargeable.
 */
export function validateSelection(
  config: PricingConfig,
  pageNumber: unknown,
  x: unknown,
  y: unknown,
  width: unknown,
  height: unknown
): ValidationResult {
  const page = toInteger(pageNumber);

  if (page === null || page < 1 || page > config.totalPages) {
    return {
      ok: false,
      error: 'invalid-page',
      message: `Page must be a whole number between 1 and ${config.totalPages}.`,
    };
  }

  const values = [x, y, width, height].map(toInteger);

  if (values.some((v) => v === null)) {
    return {
      ok: false,
      error: 'non-integer',
      message: 'Coordinates must be whole pixel values.',
    };
  }

  const [rx, ry, rw, rh] = values as number[];

  if (rw < config.minSelectionWidth || rh < config.minSelectionHeight) {
    return {
      ok: false,
      error: 'too-small',
      message: `Selection must be at least ${config.minSelectionWidth} x ${config.minSelectionHeight} pixels.`,
    };
  }

  if (
    rx < 0 ||
    ry < 0 ||
    rx + rw > config.pageWidth ||
    ry + rh > config.pageHeight
  ) {
    return {
      ok: false,
      error: 'out-of-bounds',
      message: `Selection must sit inside the ${config.pageWidth} x ${config.pageHeight} page.`,
    };
  }

  if (!rectInInventory(config, { x: rx, y: ry, width: rw, height: rh })) {
    return {
      ok: false,
      error: 'outside-inventory',
      message: `Selection must stay inside the purchasable newspaper area (rows ${config.inventoryTop} through ${config.inventoryBottom - 1}).`,
    };
  }

  return { ok: true, rect: { x: rx, y: ry, width: rw, height: rh } };
}

/**
 * Shrink a proposed rectangle so it stops short of every occupied rectangle.
 *
 * Used by the client while dragging so the selection box visibly refuses to
 * grow into pixels somebody already owns. This is a convenience for the person
 * dragging, never a security control — the server and the database both reject
 * overlaps independently.
 */
export function clampAgainstOccupied(proposed: Rect, occupied: Rect[]): Rect {
  let { x, y, width, height } = proposed;

  for (const taken of occupied) {
    if (!rectsOverlap({ x, y, width, height }, taken)) continue;

    // Work out how far we would have to pull each edge back to clear this
    // rectangle, then give up the least amount of area.
    const shrinkRight = x + width - taken.x;
    const shrinkLeft = taken.x + taken.width - x;
    const shrinkBottom = y + height - taken.y;
    const shrinkTop = taken.y + taken.height - y;

    const options = [
      { loss: shrinkRight * height, apply: () => (width -= shrinkRight) },
      { loss: shrinkBottom * width, apply: () => (height -= shrinkBottom) },
      { loss: shrinkLeft * height, apply: () => { x += shrinkLeft; width -= shrinkLeft; } },
      { loss: shrinkTop * width, apply: () => { y += shrinkTop; height -= shrinkTop; } },
    ].filter((o) => o.loss > 0);

    if (options.length === 0) continue;

    options.sort((a, b) => a.loss - b.loss)[0].apply();

    if (width <= 0 || height <= 0) return { x, y, width: 0, height: 0 };
  }

  return { x, y, width, height };
}
