/**
 * PIXEL PAPER — A PAGE OF THE NEWSPAPER
 * ============================================
 *
 * One page: 1000 × 1400 logical pixels, drawn at whatever size the layout gives
 * it. Readers drag out any rectangle at any coordinate; there are no slots and no
 * grid to snap to.
 *
 * THE ONE INVARIANT
 * -----------------
 * Coordinates are integers in logical page space, from the moment a pointer is
 * read to the moment they are sent. Rendering divides by page size to get a
 * percentage for CSS, but nothing ever travels back the other way. A percentage
 * that has been through a float and a rounded layout box is not something you
 * can charge money for.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO DECIDE
 * ---------------------------------------
 * It refuses to draw a selection over pixels somebody owns, and it shows a price
 * that moves with the cursor. Both are courtesies to the reader, not decisions:
 * the price shown here is recomputed by the server before any checkout session
 * exists, and availability is re-checked inside a locked transaction at that same
 * moment. If this component were wrong, or replaced wholesale by someone with a
 * developer console open, the worst outcome is a rejected checkout.
 *
 * The local price is computed by `calculateQuote` from `shared/pricing.ts` — the
 * exact function the server charges from — so the two agree by construction
 * rather than by careful maintenance.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ExternalLink, Lock } from 'lucide-react';

import { calculateQuote } from '../../shared/pricing.ts';
import { clampAgainstOccupied } from '../../shared/geometry.ts';
import type { PricingConfig } from '../../shared/pricing-config.ts';
import type { Rect } from '../../shared/pricing.ts';
import type { OccupiedArea, PixelSelection, PlacedAd, PriceMapCell } from '../types.ts';
import {
  clampRectToPage,
  displayUrl,
  firstBlocker,
  isBelowMinimum,
  occupiedAt,
  pixels as fmtPixels,
  rate as fmtRate,
  rectFromDrag,
  toLogicalPoint,
  usd,
  type LogicalPoint,
} from '../lib/selection.ts';

/** Which part of the selection the pointer grabbed. */
type DragMode = 'create' | 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'se' | 'sw';

interface DragState {
  mode: DragMode;
  /** Fixed corner for 'create'. */
  anchor: LogicalPoint;
  /** Rectangle at the moment the drag started, for 'move' and resizes. */
  origin: Rect;
  /** Where in the page the pointer went down, for 'move' offsets. */
  from: LogicalPoint;
}

interface NewspaperPageProps {
  pageNumber: number;
  config: PricingConfig;
  priceMap: PriceMapCell[];
  /** Live advertisements on this page. Paid bookings only. */
  ads: PlacedAd[];
  /** Everything unavailable on this page, paid or mid-checkout. */
  occupied: OccupiedArea[];
  /** True in "make the paper" mode: the page becomes a selectable canvas. */
  isSelectMode: boolean;
  showPriceMap: boolean;
  /** The current selection, if it happens to be on this page. */
  selection: PixelSelection | null;
  onSelectionChange: (selection: PixelSelection | null) => void;
  /** Fired on pointer release, so the parent can confirm price with the server. */
  onSelectionCommit: (selection: PixelSelection) => void;
  onAdClick: (ad: PlacedAd) => void;
  /** Page 1, shown alone as the front cover, carries the full masthead. */
  isCover?: boolean;
}

/**
 * Price-map tier colours — a heat scale from hot (most expensive) to cool.
 * Solid, not translucent: the wrapper carries the transparency, so cells that
 * touch never stack alpha into a darker seam. Drawn at their exact grid rect.
 */
const TIER_TINT: Record<string, string> = {
  premium: '#db2777', // magenta — hottest
  high: '#f97316', // orange
  medium: '#7c3aed', // violet
  standard: '#06b6d4', // cyan — coolest
};

const TIER_LABEL: Record<string, string> = {
  premium: 'PREMIUM',
  high: 'HIGH',
  medium: 'MEDIUM',
  standard: 'STANDARD',
};

export const NewspaperPage: React.FC<NewspaperPageProps> = ({
  pageNumber,
  config,
  priceMap,
  ads,
  occupied,
  isSelectMode,
  showPriceMap,
  selection,
  onSelectionChange,
  onSelectionCommit,
  onAdClick,
  isCover = false,
}) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [hoverBlocked, setHoverBlocked] = useState(false);
  const [refusedAt, setRefusedAt] = useState<number>(0);

  const pageMultiplier = config.pageMultipliers[pageNumber] ?? 1;
  const totalPagePixels = config.pageWidth * config.pageHeight;

  /** Only this page's selection is ours to draw. */
  const activeSelection = selection && selection.pageNumber === pageNumber ? selection : null;

  // -------------------------------------------------------------------------
  // Geometry helpers
  // -------------------------------------------------------------------------

  /** logical pixels -> CSS percentages */
  const box = useCallback(
    (rect: Rect) => ({
      left: `${(rect.x / config.pageWidth) * 100}%`,
      top: `${(rect.y / config.pageHeight) * 100}%`,
      width: `${(rect.width / config.pageWidth) * 100}%`,
      height: `${(rect.height / config.pageHeight) * 100}%`,
    }),
    [config.pageWidth, config.pageHeight]
  );

  const pointFromEvent = useCallback(
    (event: React.PointerEvent): LogicalPoint | null => {
      const bounds = canvasRef.current?.getBoundingClientRect();
      if (!bounds) return null;
      return toLogicalPoint(config, bounds, event.clientX, event.clientY);
    },
    [config]
  );

  /** Wrap a rectangle into a priced selection. Local arithmetic, server confirms. */
  const priced = useCallback(
    (rect: Rect, serverConfirmed = false): PixelSelection => ({
      ...rect,
      pageNumber,
      quote: calculateQuote(config, pageNumber, rect),
      serverConfirmed,
    }),
    [config, pageNumber]
  );

  // -------------------------------------------------------------------------
  // Resizing and moving
  // -------------------------------------------------------------------------

  /**
   * Apply a drag to produce a candidate rectangle.
   *
   * 'create' is allowed to be trimmed by `clampAgainstOccupied`, which shrinks
   * the rectangle off whichever edge is cheapest to give up — so dragging across
   * a claimed area feels like the selection is being held back rather than
   * refusing to move at all. Moves and resizes are all-or-nothing: if the result
   * would overlap, the previous rectangle stands.
   */
  const candidateFor = useCallback(
    (drag: DragState, point: LogicalPoint): Rect | null => {
      if (drag.mode === 'create') {
        const raw = rectFromDrag(drag.anchor, point);
        const trimmed = clampAgainstOccupied(raw, occupied);
        return trimmed.width > 0 && trimmed.height > 0 ? trimmed : null;
      }

      const o = drag.origin;
      let next: Rect;

      if (drag.mode === 'move') {
        next = clampRectToPage(config, {
          x: o.x + (point.x - drag.from.x),
          y: o.y + (point.y - drag.from.y),
          width: o.width,
          height: o.height,
        });
      } else {
        // Resize: recompute the two moving edges, keep the opposite ones fixed.
        let left = o.x;
        let top = o.y;
        let right = o.x + o.width - 1;
        let bottom = o.y + o.height - 1;

        if (drag.mode.includes('w')) left = Math.min(point.x, right);
        if (drag.mode.includes('e')) right = Math.max(point.x, left);
        if (drag.mode.includes('n')) top = Math.min(point.y, bottom);
        if (drag.mode.includes('s')) bottom = Math.max(point.y, top);

        next = clampRectToPage(config, {
          x: left,
          y: top,
          width: right - left + 1,
          height: bottom - top + 1,
        });
      }

      return firstBlocker(next, occupied) ? null : next;
    },
    [config, occupied]
  );

  // -------------------------------------------------------------------------
  // Pointer handling
  // -------------------------------------------------------------------------
  //
  // Pointer events rather than mouse events, so a finger on a phone and a mouse
  // on a desktop run the same code path. `setPointerCapture` keeps a drag alive
  // when the pointer leaves the page edge, which is exactly what someone
  // selecting right up to the margin will do.
  //
  // Only the primary pointer draws. The second finger of a pinch also raises
  // pointerdown, and without this guard it would restart the drag from wherever
  // that finger landed — so zooming in to place a rectangle precisely would
  // destroy the rectangle.

  const beginDrag = useCallback(
    (event: React.PointerEvent, mode: DragMode) => {
      if (!isSelectMode) return;
      if (!event.isPrimary) return;

      const point = pointFromEvent(event);
      if (!point) return;

      if (mode === 'create') {
        // Starting on top of somebody's pixels is refused outright.
        if (occupiedAt(occupied, point)) {
          setRefusedAt(Date.now());
          return;
        }
        onSelectionChange(priced({ x: point.x, y: point.y, width: 1, height: 1 }));
      }

      const origin: Rect = activeSelection
        ? {
            x: activeSelection.x,
            y: activeSelection.y,
            width: activeSelection.width,
            height: activeSelection.height,
          }
        : { x: point.x, y: point.y, width: 1, height: 1 };

      dragRef.current = { mode, anchor: point, origin, from: point };
      setIsDragging(true);

      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [activeSelection, isSelectMode, occupied, onSelectionChange, pointFromEvent, priced]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      // Same reason as `beginDrag`: pointer capture redirects the captured
      // pointer, not the other one, so a second finger sliding across the page
      // would otherwise drag the rectangle's corner along with it.
      if (!event.isPrimary) return;

      const point = pointFromEvent(event);
      if (!point) return;

      const drag = dragRef.current;

      if (!drag) {
        // Not dragging: the cursor's job is to say whether this pixel is for sale.
        if (isSelectMode) setHoverBlocked(occupiedAt(occupied, point) !== null);
        return;
      }

      const next = candidateFor(drag, point);
      if (next) onSelectionChange(priced(next));

      event.preventDefault();
    },
    [candidateFor, isSelectMode, occupied, onSelectionChange, pointFromEvent, priced]
  );

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      if (!event.isPrimary) return;
      if (!dragRef.current) return;

      dragRef.current = null;
      setIsDragging(false);
      event.currentTarget.releasePointerCapture?.(event.pointerId);

      // Ask the server for the real figure. Until it answers, the reader is
      // looking at an estimate, and the interface says so.
      if (activeSelection) onSelectionCommit(activeSelection);
    },
    [activeSelection, onSelectionCommit]
  );

  // -------------------------------------------------------------------------
  // Price map
  // -------------------------------------------------------------------------
  //
  // Built from the same attention field that sets the price. Each cell is drawn
  // at its exact normalised rect (u, v, w, h) — the same coordinate space as
  // `box()` above — so the overlay lines up with the page pixel-for-pixel. No
  // scaling, no offsets: same-tier neighbours merge into a clean zone, and the
  // steps between tiers fall exactly on the grid.

  const priceMapCells = useMemo(() => {
    if (!showPriceMap) return null;

    return priceMap.map((cell, index) => {
      const color = TIER_TINT[cell.tier] ?? TIER_TINT.standard;
      return (
        <div
          key={index}
          className="absolute"
          style={{
            left: `${cell.u * 100}%`,
            top: `${cell.v * 100}%`,
            width: `${cell.w * 100}%`,
            height: `${cell.h * 100}%`,
            backgroundColor: color,
            // A hairline ring in the same solid colour seals sub-pixel seams
            // between cells without expanding the cell or shifting its origin.
            boxShadow: `0 0 0 0.5px ${color}`,
          }}
        />
      );
    });
  }, [priceMap, showPriceMap]);

  /**
   * One label per tier, placed at the centroid of that tier's cells so it sits
   * in the middle of the zone it names rather than on a boundary cell.
   */
  const tierAnchors = useMemo(() => {
    if (!showPriceMap || priceMap.length === 0) return [];

    const groups = new Map<
      string,
      { su: number; sv: number; sm: number; count: number }
    >();
    for (const cell of priceMap) {
      const g = groups.get(cell.tier) ?? { su: 0, sv: 0, sm: 0, count: 0 };
      g.su += cell.u + cell.w / 2;
      g.sv += cell.v + cell.h / 2;
      g.sm += cell.multiplier;
      g.count += 1;
      groups.set(cell.tier, g);
    }

    const order = ['premium', 'high', 'medium', 'standard'];
    return [...groups.entries()]
      .map(([tier, g]) => ({
        tier,
        u: g.su / g.count,
        v: g.sv / g.count,
        multiplier: g.sm / g.count,
      }))
      .sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
  }, [priceMap, showPriceMap]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const cursor = isSelectMode ? (hoverBlocked ? 'not-allowed' : 'crosshair') : 'default';
  const tooSmall = activeSelection ? isBelowMinimum(config, activeSelection) : false;
  const refusedRecently = Date.now() - refusedAt < 1200;

  return (
    <div className="relative w-full">
      {/* ==================================================================
          THE PAGE
          Locked to the logical aspect ratio. Every percentage below is
          therefore a faithful fraction of a real pixel coordinate — without
          this lock, a rectangle would be priced by one shape and drawn as
          another.
          ================================================================== */}
      <div
        className="newsprint broadsheet-shadow relative w-full overflow-hidden border border-[#dcd6ec] dark:border-[#2a2740]"
        style={{ aspectRatio: `${config.pageWidth} / ${config.pageHeight}` }}
      >
        {/* ---------- Static page furniture ---------- */}
        <div className="pointer-events-none absolute inset-0 flex flex-col p-[3%]">
          {isCover ? (
            <header className="border-double-thick border-[#191627] pb-[1.5%] text-center text-[#191627] dark:border-[#332f47] dark:text-[#f2f0fb]">
              <div className="font-data text-[0.62vw] font-bold uppercase tracking-[0.35em] opacity-70 sm:text-[9px]">
                Where every pixel can become yours
              </div>
              <h1 className="font-masthead text-[5.2vw] leading-[0.95] font-black uppercase tracking-tight sm:text-[3.4vw] lg:text-[2.6vw]">
                Pixel <span className="pp-word">Paper</span>
              </h1>
              <div className="font-editorial text-[0.75vw] italic opacity-70 sm:text-[10px]">
                Choose any available space. Add your link. Pay once. Stay here permanently.
              </div>
            </header>
          ) : (
            <header className="flex items-baseline justify-between border-b border-[#191627]/30 pb-[1%] font-data text-[0.62vw] font-bold uppercase tracking-[0.25em] text-[#191627]/60 dark:border-[#f2f0fb]/20 dark:text-[#f2f0fb]/50 sm:text-[9px]">
              <span>Pixel Paper</span>
              <span>Page {pageNumber}</span>
            </header>
          )}

          {/* Column rules. They give an empty page structure without printing
              a single word of content nobody bought. */}
          <div className="relative flex-1">
            <div className="absolute inset-0 flex">
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className={`flex-1 ${
                    index > 0 ? 'border-l border-[#191627]/8 dark:border-[#f2f0fb]/8' : ''
                  }`}
                />
              ))}
            </div>

            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center opacity-[0.06] dark:opacity-[0.1]">
                <div className="font-masthead text-[3vw] font-black uppercase leading-none">
                  {fmtPixels(totalPagePixels)}
                </div>
                <div className="font-data text-[0.8vw] font-bold uppercase tracking-[0.4em]">
                  pixels
                </div>
              </div>
            </div>
          </div>

          <footer className="flex items-baseline justify-between border-t border-[#191627]/30 pt-[1%] font-data text-[0.6vw] uppercase tracking-[0.2em] text-[#191627]/50 dark:border-[#f2f0fb]/20 dark:text-[#f2f0fb]/40 sm:text-[8px]">
            <span>
              {config.pageWidth} × {config.pageHeight} px
            </span>
            <span>Page {pageNumber} of {config.totalPages}</span>
          </footer>
        </div>

        {/* ---------- Price map ---------- */}
        {priceMapCells && (
          <>
            <div className="pointer-events-none absolute inset-0 opacity-55 mix-blend-multiply dark:opacity-45 dark:mix-blend-screen">
              {priceMapCells}
            </div>

            {tierAnchors.map((anchor) => (
              <div
                key={anchor.tier}
                className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-white/90 px-2 py-0.5 font-data text-[8px] font-black uppercase tracking-widest text-[#191627] shadow-sm ring-1 ring-black/5 dark:bg-black/80 dark:text-white dark:ring-white/10"
                style={{ left: `${anchor.u * 100}%`, top: `${anchor.v * 100}%` }}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: TIER_TINT[anchor.tier] ?? TIER_TINT.standard }}
                />
                <span>
                  {TIER_LABEL[anchor.tier]} ·{' '}
                  {fmtRate(config.baseRate * pageMultiplier * anchor.multiplier)}/px
                </span>
              </div>
            ))}
          </>
        )}

        {/* ---------- Live advertisements ---------- */}
        {ads.map((ad) => (
          <AdBlock
            key={ad.bookingId}
            ad={ad}
            style={box(ad)}
            interactive={!isSelectMode}
            onOpen={() => onAdClick(ad)}
          />
        ))}

        {/* ==================================================================
            SELECTION CANVAS
            Only mounted in select mode, so reading the paper is never
            intercepted by a drag handler.

            `touchAction: 'pinch-zoom'` is the whole mobile story, and it sits in
            `style` beside `cursor` because both are pointer behaviour rather
            than decoration. One finger draws a rectangle without the page
            scrolling away underneath it; two fingers are left to the browser.
            On a phone a page pixel is a fraction of a millimetre wide, so
            someone buying a precise rectangle has to be able to zoom in first,
            and `touch-action: none` would have taken that away. Pinching
            mid-drag cancels the drag, which commits whatever was drawn — the
            handles are there to refine it once zoomed.
            ================================================================== */}
        {isSelectMode && (
          <div
            ref={canvasRef}
            className="absolute inset-0"
            style={{ cursor, touchAction: 'pinch-zoom' }}
            onPointerDown={(event) => beginDrag(event, 'create')}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => setHoverBlocked(false)}
          >
            {/* Faint measuring grid, only while selecting. */}
            <div className="pixel-grid pointer-events-none absolute inset-0" />

            {/* Claimed and held areas. Hatched, cursor refused, never selectable. */}
            {occupied.map((area, index) => (
              <div
                key={`${area.x}-${area.y}-${index}`}
                className={`claimed-hatch absolute flex items-center justify-center overflow-hidden border ${
                  area.status === 'paid'
                    ? 'border-[#191627]/50 dark:border-white/35'
                    : 'border-dashed border-[#d97706] dark:border-[#f59e0b]'
                }`}
                style={{ ...box(area), cursor: 'not-allowed' }}
                title={
                  area.status === 'paid'
                    ? 'Permanently claimed'
                    : 'Someone is checking out for this area right now'
                }
              >
                <span className="flex items-center gap-1 whitespace-nowrap rounded-xs bg-[#191627]/85 px-1.5 py-0.5 font-data text-[8px] font-black uppercase tracking-widest text-white dark:bg-[#f2f0fb]/90 dark:text-[#191627]">
                  <Lock className="h-2.5 w-2.5" />
                  {area.status === 'paid' ? 'Permanently claimed' : 'Held'}
                </span>
              </div>
            ))}

            {/* The selection. */}
            {activeSelection && (
              <div
                className={`absolute border-2 ${
                  tooSmall
                    ? 'border-[#d97706] bg-[#d97706]/12 dark:border-[#f59e0b] dark:bg-[#f59e0b]/15'
                    : 'border-[#2563eb] bg-[#2563eb]/12 dark:border-[#60a5fa] dark:bg-[#60a5fa]/15'
                }`}
                style={{ ...box(activeSelection), cursor: isDragging ? 'grabbing' : 'move' }}
                onPointerDown={(event) => beginDrag(event, 'move')}
              >
                {/* Eight handles. Each grabs its own edges; the opposite edges
                    stay put, which is what makes a resize feel like a resize. */}
                {(
                  [
                    ['nw', '-top-1 -left-1', 'nwse-resize'],
                    ['n', '-top-1 left-1/2 -translate-x-1/2', 'ns-resize'],
                    ['ne', '-top-1 -right-1', 'nesw-resize'],
                    ['e', 'top-1/2 -right-1 -translate-y-1/2', 'ew-resize'],
                    ['se', '-bottom-1 -right-1', 'nwse-resize'],
                    ['s', '-bottom-1 left-1/2 -translate-x-1/2', 'ns-resize'],
                    ['sw', '-bottom-1 -left-1', 'nesw-resize'],
                    ['w', 'top-1/2 -left-1 -translate-y-1/2', 'ew-resize'],
                  ] as [DragMode, string, string][]
                ).map(([mode, position, handleCursor]) => (
                  <div
                    key={mode}
                    className={`absolute h-2.5 w-2.5 rounded-xs border-2 border-[#2563eb] bg-white dark:border-[#60a5fa] dark:bg-[#16131f] ${position}`}
                    style={{ cursor: handleCursor }}
                    onPointerDown={(event) => beginDrag(event, mode)}
                  />
                ))}
              </div>
            )}

            {/* Live readout. Everything a buyer needs to decide, while the
                cursor is still moving: size, pixel count, the base rate, what
                this position does to it, and the total. */}
            {activeSelection && (
              <SelectionReadout
                selection={activeSelection}
                config={config}
                tooSmall={tooSmall}
                box={box(activeSelection)}
              />
            )}

            {refusedRecently && (
              <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
                <span className="rounded-xs bg-[#191627] px-2.5 py-1 font-data text-[10px] font-black uppercase tracking-widest text-white shadow-lg dark:bg-[#f2f0fb] dark:text-[#191627]">
                  Those pixels are already owned
                </span>
              </div>
            )}
          </div>
        )}

        {/* ---------- An honest empty page ---------- */}
        {!isSelectMode && ads.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-[8%]">
            <div className="max-w-[70%] rounded-xs border border-dashed border-[#191627]/25 bg-[#fdfcff]/80 px-4 py-3 text-center backdrop-blur-[1px] dark:border-white/20 dark:bg-[#16131f]/80">
              <div className="font-data text-[9px] font-black uppercase tracking-[0.3em] text-[#7c3aed] dark:text-[#a78bfa]">
                Entirely unclaimed
              </div>
              <p className="mt-1 font-editorial text-[11px] leading-snug text-[#514c62] dark:text-[#a49eb6]">
                Every pixel on this page is available. Nothing here is a placeholder —
                the page is blank because no one has bought it yet.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// The live readout
// ---------------------------------------------------------------------------

/**
 * Pinned to the selection, flipping to whichever side has room. Shows the five
 * figures that decide a purchase, and says plainly that the total is not final
 * until the server has spoken.
 */
const SelectionReadout: React.FC<{
  selection: PixelSelection;
  config: PricingConfig;
  tooSmall: boolean;
  box: { left: string; top: string; width: string; height: string };
}> = ({ selection, config, tooSmall, box }) => {
  const { quote } = selection;
  const below = selection.y < config.pageHeight * 0.5;

  return (
    <div
      className="pointer-events-none absolute z-20"
      style={{
        left: box.left,
        top: below ? `calc(${box.top} + ${box.height})` : box.top,
        transform: below ? 'translateY(6px)' : 'translateY(calc(-100% - 6px))',
      }}
    >
      <div className="min-w-[190px] rounded-xs border border-[#191627] bg-[#faf9fe] px-2.5 py-2 font-data text-[10px] shadow-xl dark:border-[#413c54] dark:bg-[#131120]">
        <div className="flex items-baseline justify-between gap-3 border-b border-[#e0dcf0] pb-1 dark:border-[#2a2740]">
          <span className="font-black uppercase tracking-wider text-[#191627] dark:text-white">
            {selection.width} × {selection.height} px
          </span>
          <span className="text-[#6f6a80] dark:text-zinc-400">
            {fmtPixels(quote.pixelCount)} px
          </span>
        </div>

        <dl className="space-y-0.5 py-1 text-[#514c62] dark:text-zinc-400">
          <div className="flex justify-between gap-3">
            <dt>Price per pixel</dt>
            <dd className="text-[#191627] dark:text-zinc-200">{fmtRate(quote.baseRate)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Page {selection.pageNumber}</dt>
            <dd className="text-[#191627] dark:text-zinc-200">×{quote.pageMultiplier.toFixed(2)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>{quote.positionLabel}</dt>
            <dd className="text-[#191627] dark:text-zinc-200">
              ×{quote.positionMultiplier.toFixed(2)}
            </dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-[#e0dcf0] pt-0.5 font-bold text-[#2563eb] dark:border-[#2a2740] dark:text-[#60a5fa]">
            <dt>Effective rate</dt>
            <dd>{fmtRate(quote.effectiveRate)}</dd>
          </div>
        </dl>

        {tooSmall ? (
          <div className="rounded-xs bg-[#fef3c7] px-1.5 py-1 text-center font-black uppercase tracking-wider text-[#92400e] dark:bg-[#78350f]/50 dark:text-[#fcd34d]">
            Minimum {config.minSelectionWidth} × {config.minSelectionHeight} px
          </div>
        ) : (
          <div className="flex items-baseline justify-between gap-3 border-t border-[#191627] pt-1 dark:border-[#413c54]">
            <span className="font-black uppercase tracking-wider text-[#191627] dark:text-white">
              {selection.serverConfirmed ? 'Total' : 'Estimate'}
            </span>
            <span className="font-headline text-base font-black text-emerald-700 dark:text-emerald-400">
              {usd(quote.totalPrice)}
            </span>
          </div>
        )}

        {quote.minimumApplied && !tooSmall && (
          <div className="pt-0.5 text-[8px] uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
            Minimum charge applied
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// A live advertisement
// ---------------------------------------------------------------------------

/**
 * Someone's permanent space, drawn at exactly the pixels they bought.
 *
 * Because a space can be any size, the contents are chosen by how much room
 * there actually is, and text is sized in container-query units so a 900-pixel
 * wide block and a 90-pixel wide block both look deliberate. There is no minimum
 * "ad shape" — the buyer picked the shape.
 */
const AdBlock: React.FC<{
  ad: PlacedAd;
  style: React.CSSProperties;
  interactive: boolean;
  onOpen: () => void;
}> = ({ ad, style, interactive, onOpen }) => {
  const area = ad.width * ad.height;

  // A logo-only ad was stored with an image and no headline. It renders as just
  // the linked image filling the whole space that was bought — `object-cover`, so
  // the logo covers every purchased pixel edge to edge with no empty border, and
  // the buyer is not charged for margin they did not want. When the image's shape
  // differs from the box the overflow is cropped (never letterboxed or stretched),
  // which is why the box has `overflow-hidden`. It deliberately skips the 260×200
  // gate below that keeps decorative images out of tiny ordinary ads.
  const logoOnly = Boolean(ad.imageUrl) && ad.headline.length === 0;

  const showImage = Boolean(ad.imageUrl) && ad.width >= 260 && ad.height >= 200;
  const showDescription = Boolean(ad.description) && area >= 90_000 && ad.height >= 160;
  const showCta = Boolean(ad.ctaText) && ad.height >= 110 && ad.width >= 200;
  const showHeadline = ad.height >= 70 && ad.width >= 110;

  // One accessible name for both the link title and the image alt. An ordinary ad
  // reads "Brand — Headline"; a logo-only ad falls back to the brand, or to the
  // destination when even that was left blank, so the link is never unlabelled.
  const label = ad.headline
    ? ad.brandName
      ? `${ad.brandName} — ${ad.headline}`
      : ad.headline
    : ad.brandName || displayUrl(ad.destinationUrl);

  return (
    <a
      href={ad.destinationUrl}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(event) => {
        // In reading mode the link is the point. The detail view is a
        // modifier-free secondary gesture handled by the parent.
        if (!interactive) event.preventDefault();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpen();
      }}
      className={`absolute flex flex-col overflow-hidden border border-[#191627] bg-[#fffeff] text-[#191627] no-underline transition-shadow dark:border-[#413c54] dark:bg-[#1a1726] dark:text-[#f2f0fb] ${
        interactive ? 'hover:shadow-lg' : 'pointer-events-none'
      }`}
      style={{ ...style, containerType: 'inline-size' }}
      title={label}
    >
      {logoOnly ? (
        <img
          src={ad.imageUrl}
          alt={label}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-1 border-b border-current/20 px-[4cqw] py-[2cqw]">
            <span
              className="truncate font-data font-black uppercase tracking-wider"
              style={{ fontSize: 'clamp(6px, 5cqw, 11px)' }}
            >
              {ad.brandName}
            </span>
            <span
              className="shrink-0 font-data uppercase opacity-50"
              style={{ fontSize: 'clamp(5px, 3.6cqw, 8px)' }}
            >
              {fmtPixels(ad.pixelCount)} px
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-[1.5cqw] px-[4cqw] py-[2.5cqw]">
            {showImage && (
              <div className="min-h-0 flex-1 overflow-hidden bg-black/5 dark:bg-black/30">
                <img
                  src={ad.imageUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-contain"
                />
              </div>
            )}

            {showHeadline && (
              <h3
                className="font-headline font-black uppercase leading-tight tracking-tight"
                style={{ fontSize: 'clamp(8px, 8cqw, 26px)' }}
              >
                {ad.headline}
              </h3>
            )}

            {showDescription && (
              <p
                className="font-editorial leading-snug opacity-85"
                style={{ fontSize: 'clamp(7px, 5cqw, 14px)' }}
              >
                {ad.description}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-1 border-t border-current/20 px-[4cqw] py-[2cqw]">
            <span
              className="flex min-w-0 items-center gap-[1cqw] truncate font-data font-bold underline"
              style={{ fontSize: 'clamp(5px, 4cqw, 10px)' }}
            >
              <ExternalLink className="h-[1em] w-[1em] shrink-0" />
              <span className="truncate">{displayUrl(ad.destinationUrl)}</span>
            </span>

            {showCta && (
              <span
                className="shrink-0 bg-[#191627] px-[3cqw] py-[1.5cqw] font-data font-black uppercase tracking-wider text-white dark:bg-[#f2f0fb] dark:text-[#191627]"
                style={{ fontSize: 'clamp(5px, 3.6cqw, 9px)' }}
              >
                {ad.ctaText}
              </span>
            )}
          </div>
        </>
      )}
    </a>
  );
};
