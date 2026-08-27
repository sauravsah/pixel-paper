/**
 * SELECTION GEOMETRY (CLIENT)
 * ===========================
 *
 * Turning pointer positions into the integer rectangles the server prices.
 *
 * The overlap and validation rules themselves are *not* reimplemented here —
 * they come from `shared/geometry.ts`, the same module the server runs. That
 * matters for one specific reason: if the browser drew selections by a slightly
 * different rule than the server validated them by, a reader could drag out a
 * rectangle the interface said was fine and then be refused at checkout with no
 * explanation. Same module, same answer, every time.
 *
 * Nothing in this file decides anything binding. It shapes what the cursor does.
 * Availability and price are settled by the server.
 */

import type { PricingConfig } from '../../shared/pricing-config.ts';
import type { Rect } from '../../shared/pricing.ts';
import { inventoryRect, rectsOverlap } from '../../shared/geometry.ts';
import type { OccupiedArea } from '../types.ts';

/** Where a pointer sits inside a page, in integer logical pixels. */
export interface LogicalPoint {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Convert a client (viewport) position into an integer pixel on the page.
 *
 * The page is drawn at whatever size the layout gives it and is always locked to
 * the logical aspect ratio, so this is a straight proportional map. Rounding
 * happens once, here, and never again — every consumer downstream works in
 * integers.
 */
export function toLogicalPoint(
  config: PricingConfig,
  bounds: DOMRect,
  clientX: number,
  clientY: number
): LogicalPoint {
  const u = bounds.width > 0 ? (clientX - bounds.left) / bounds.width : 0;
  const v = bounds.height > 0 ? (clientY - bounds.top) / bounds.height : 0;

  return {
    x: clamp(Math.floor(u * config.pageWidth), 0, config.pageWidth - 1),
    y: clamp(Math.floor(v * config.pageHeight), 0, config.pageHeight - 1),
  };
}

/**
 * The rectangle between two dragged corners.
 *
 * Both endpoints are inclusive: dragging from pixel 10 to pixel 12 buys pixels
 * 10, 11 and 12, so the width is 3. This is the same half-open convention the
 * database uses (`x` .. `x + width - 1`), which is why two areas that touch
 * edge-to-edge are both legal rather than counting as an overlap.
 */
export function rectFromDrag(a: LogicalPoint, b: LogicalPoint): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(b.x - a.x) + 1,
    height: Math.abs(b.y - a.y) + 1,
  };
}

/** Push a rectangle back inside the page without changing its size, if it fits. */
export function clampRectToPage(config: PricingConfig, rect: Rect): Rect {
  const width = clamp(rect.width, 1, config.pageWidth);
  const height = clamp(rect.height, 1, config.pageHeight);

  return {
    x: clamp(rect.x, 0, config.pageWidth - width),
    y: clamp(rect.y, 0, config.pageHeight - height),
    width,
    height,
  };
}

/** Push a rectangle inside the purchasable band without changing its size when it fits. */
export function clampRectToInventory(config: PricingConfig, rect: Rect): Rect {
  const inventory = inventoryRect(config);
  const width = clamp(rect.width, 1, inventory.width);
  const height = clamp(rect.height, 1, inventory.height);

  return {
    x: clamp(rect.x, inventory.x, inventory.x + inventory.width - width),
    y: clamp(rect.y, inventory.y, inventory.y + inventory.height - height),
    width,
    height,
  };
}

/** The first occupied area a rectangle runs into, or null. */
export function firstBlocker(rect: Rect, occupied: OccupiedArea[]): OccupiedArea | null {
  for (const area of occupied) {
    if (rectsOverlap(rect, area)) return area;
  }
  return null;
}

/** Whether a rectangle is below the minimum purchasable size. */
export function isBelowMinimum(config: PricingConfig, rect: Rect): boolean {
  return rect.width < config.minSelectionWidth || rect.height < config.minSelectionHeight;
}

/**
 * Does a point land on something already owned?
 *
 * Used to decide the cursor before a drag begins. A reader should be told the
 * area is unavailable by the pointer changing shape, not by an error after they
 * have finished dragging.
 */
export function occupiedAt(occupied: OccupiedArea[], point: LogicalPoint): OccupiedArea | null {
  for (const area of occupied) {
    if (
      point.x >= area.x &&
      point.x < area.x + area.width &&
      point.y >= area.y &&
      point.y < area.y + area.height
    ) {
      return area;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * A per-pixel rate, which is a fraction of a cent, so `toFixed(2)` would print
 * every rate on the site as "$0.00". Six decimals is enough to see the
 * multipliers move.
 */
export function rate(perPixel: number): string {
  return `$${perPixel.toFixed(6)}`;
}

export function pixels(count: number): string {
  return count.toLocaleString('en-US');
}

/** "example.com/path" — a destination shown as a newspaper would print it. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
