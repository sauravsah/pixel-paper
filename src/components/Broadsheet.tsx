/**
 * THE BROADSHEET — FRONT PAGE PLUS SPREADS
 * ========================================
 *
 * The paper starts with a front page, then two-page spreads:
 *
 *   view 0: page 1
 *   view 1: pages 2-3
 *   view 2: pages 4-5
 *   ...
 *
 * HOW THE TURN WORKS
 * ------------------
 * The stage is always two pages wide, with a `left` and a `right` slot. The cover
 * lives in the right slot with the left slot empty; the back page lives in the
 * left slot with the right slot empty. The whole stage then slides a quarter of
 * its width so that a lone page still reads as centred on screen.
 *
 * That one decision is what makes the animation honest. Because the slots never
 * change size, a page turn is always the same motion: a leaf hinged on the middle
 * of the stage, rotating 180° about its spine edge. Its front face is the page you
 * were looking at, its back face is the page you are about to see. The destination
 * spread is mounted underneath the whole time, so when the leaf lands it is
 * covering the very page already sitting there and the two are indistinguishable.
 * Nothing is faked with a crossfade, and no content is swapped mid-flight.
 *
 *   forward  (v → v+1):  leaf = right slot, hinge on its left edge,  0° → -180°
 *   backward (v → v-1):  leaf = left slot,  hinge on its right edge, 0° →  180°
 *
 * Check it against the diagram: turning forward from the cover puts page 1's back
 * where page 2 belongs. Turning back from any spread puts the left page's back
 * where the previous right page belongs. Every transition follows the same rule,
 * regardless of the configured page count.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';

import { PRICING_CONFIG, type PricingConfig } from '../../shared/pricing-config.ts';
import type { OccupiedArea, PixelSelection, PlacedAd, PriceMapCell } from '../types.ts';
import { NewspaperPage } from './NewspaperPage.tsx';

interface PageSlots {
  left: number | null;
  right: number | null;
}

export function buildViews(totalPages: number): PageSlots[] {
  const views: PageSlots[] = [{ left: null, right: 1 }];
  for (let page = 2; page <= totalPages; page += 2) {
    views.push({ left: page, right: page + 1 <= totalPages ? page + 1 : null });
  }
  return views;
}

const DEFAULT_VIEWS = buildViews(PRICING_CONFIG.totalPages);
export const VIEW_COUNT = DEFAULT_VIEWS.length;

/** How far to slide the stage so a lone page appears centred. */
function stageOffset(view: number, views = DEFAULT_VIEWS): string {
  const slots = views[view];
  if (!slots) return '0%';
  // A lone page sits in one slot of the two-wide stage; slide the stage by a
  // quarter of its width *toward* the empty slot so the page lands on centre.
  // Cover (page in the right slot) pulls left; back page (left slot) pushes right.
  if (slots.left === null) return '-25%';
  if (slots.right === null) return '25%';
  return '0%';
}

/** A short human label for the view, used by the navigation chrome. */
export function viewLabel(view: number, totalPages = PRICING_CONFIG.totalPages): string {
  const slots = buildViews(totalPages)[view];
  if (!slots) return '';
  if (slots.left === null) return `Page ${slots.right}`;
  if (slots.right === null) return `Page ${slots.left}`;
  return `Pages ${slots.left}–${slots.right}`;
}

export function pagesInView(view: number, totalPages = PRICING_CONFIG.totalPages): number[] {
  const slots = buildViews(totalPages)[view];
  if (!slots) return [];
  return [slots.left, slots.right].filter((p): p is number => p !== null);
}

/**
 * The view a given page can be seen on.
 *
 * Needed whenever something outside the paper knows a page number and has to
 * bring the reader to it — a shared link, or "view my space" after a purchase.
 * Falls back to the cover rather than throwing, because a bad page number in a
 * URL should land somewhere sensible.
 */
export function viewForPage(pageNumber: number, totalPages = PRICING_CONFIG.totalPages): number {
  const index = buildViews(totalPages).findIndex(
    (slots) => slots.left === pageNumber || slots.right === pageNumber
  );
  return index === -1 ? 0 : index;
}

interface Flip {
  direction: 'forward' | 'backward';
  /** The page on the face of the turning leaf. */
  front: number;
  /** The page revealed on its underside. */
  back: number;
  /** The view being turned to; mounted underneath from the first frame. */
  to: number;
}

interface BroadsheetProps {
  view: number;
  onViewChange: (view: number) => void;
  config: PricingConfig;
  priceMap: PriceMapCell[];
  ads: PlacedAd[];
  occupied: OccupiedArea[];
  isSelectMode: boolean;
  showPriceMap: boolean;
  selection: PixelSelection | null;
  onSelectionChange: (selection: PixelSelection | null) => void;
  onSelectionCommit: (selection: PixelSelection) => void;
  onAdClick: (ad: PlacedAd) => void;
  /** True when this copy is the one rendered inside the focus-mode overlay. */
  immersive?: boolean;
  /** Enter or leave focus mode. Absent in contexts where focus mode is disabled. */
  onToggleImmersive?: () => void;
}

const TURN_DURATION = 0.62;
const TURN_EASE = [0.35, 0, 0.15, 1] as const;

export const Broadsheet: React.FC<BroadsheetProps> = ({
  view,
  onViewChange,
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
  immersive = false,
  onToggleImmersive,
}) => {
  const [flip, setFlip] = useState<Flip | null>(null);
  const [mobilePage, setMobilePage] = useState(1);
  const flipping = flip !== null;
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const views = buildViews(config.totalPages);
  const viewCount = views.length;

  useEffect(() => {
    const mobileView = buildViews(config.totalPages)[view];
    setMobilePage(mobileView?.left ?? mobileView?.right ?? 1);
  }, [config.totalPages, view]);

  const canBack = view > 0;
  const canForward = view < viewCount - 1;

  const turnMobile = useCallback(
    (direction: 'forward' | 'backward') => {
      const nextPage = mobilePage + (direction === 'forward' ? 1 : -1);
      if (nextPage < 1 || nextPage > config.totalPages) return;

      setMobilePage(nextPage);
      onViewChange(nextPage === 1 ? 0 : Math.floor((nextPage - 2) / 2) + 1);
    },
    [config.totalPages, mobilePage, onViewChange]
  );

  const turn = useCallback(
    (direction: 'forward' | 'backward') => {
      // One turn at a time. A second turn mid-flight would need a second leaf
      // and would let the reader lose track of where they are.
      if (flipping) return;

      const to = direction === 'forward' ? view + 1 : view - 1;
      if (to < 0 || to >= viewCount) return;

      const current = views[view];
      const target = views[to];
      if (!current || !target) return;

      const front = direction === 'forward' ? current.right : current.left;
      const back = direction === 'forward' ? target.left : target.right;
      if (front === null || back === null) return;

      setFlip({ direction, front, back, to });
      onViewChange(to);
    },
    [flipping, onViewChange, view, viewCount, views]
  );

  // ---- Keyboard ----------------------------------------------------------
  // Arrow keys turn the page, except while the reader is typing — otherwise
  // moving the caret in the headline field would flip the paper underneath them.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        turn('forward');
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        turn('backward');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [turn]);

  // ---- Rendering helpers -------------------------------------------------

  const renderPage = useCallback(
    (pageNumber: number, options: { selectable: boolean; isCover: boolean }) => (
      <NewspaperPage
        pageNumber={pageNumber}
        config={config}
        priceMap={priceMap}
        ads={ads.filter((ad) => ad.pageNumber === pageNumber)}
        occupied={occupied.filter((area) => area.pageNumber === pageNumber)}
        isSelectMode={options.selectable && isSelectMode}
        showPriceMap={showPriceMap}
        selection={selection}
        onSelectionChange={onSelectionChange}
        onSelectionCommit={onSelectionCommit}
        onAdClick={onAdClick}
        isCover={options.isCover}
      />
    ),
    [
      ads,
      config,
      isSelectMode,
      occupied,
      onAdClick,
      onSelectionChange,
      onSelectionCommit,
      priceMap,
      selection,
      showPriceMap,
    ]
  );

  /** The spread mounted under the leaf: the destination once a turn begins. */
  const settledView = flip ? flip.to : view;
  const slots = views[settledView] ?? views[0]!;

  // The stage holds two page-shaped slots side by side, so its ratio is the page
  // ratio doubled. Everything inside is a percentage of this box.
  const stageAspect = `${config.pageWidth * 2} / ${config.pageHeight}`;

  return (
    <div className="relative w-full">
      <div
        className={`mx-auto hidden w-full px-1 sm:block sm:px-3 ${immersive ? '' : 'max-w-[1600px]'}`}
        style={
          immersive
            ? {
                // Focus mode is width-driven but the stage is aspect-locked, so cap
                // the width by viewport height too — the whole spread and the nav row
                // below it stay visible without scrolling. Falls back to full width on
                // tall/narrow (mobile) viewports.
                maxWidth: `min(95vw, calc((100vh - 112px) * ${(config.pageWidth * 2) / config.pageHeight}))`,
              }
            : undefined
        }
        onTouchStart={(event) => {
          // A pointer event's preventDefault does not suppress the touch events
          // the browser fires alongside it, so without these two guards a drag
          // meant to draw a rectangle would also turn the page out from under
          // it, and a pinch to zoom in would count as a swipe. In select mode
          // the arrows and the arrow keys are the way to change page.
          if (isSelectMode || event.touches.length > 1) {
            touchStart.current = null;
            return;
          }
          const t = event.touches[0];
          touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(event) => {
          const start = touchStart.current;
          const t = event.changedTouches[0];
          touchStart.current = null;
          if (!start || !t) return;

          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          // Horizontal intent only, and far enough to be deliberate. A 45px
          // threshold keeps a scroll from being read as a page turn.
          if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
          turn(dx < 0 ? 'forward' : 'backward');
        }}
      >
        {/* The slide that keeps a lone page centred. */}
        <motion.div
          animate={{ x: stageOffset(settledView, views) }}
          transition={{ duration: TURN_DURATION, ease: TURN_EASE }}
          className="relative w-full"
          style={{ aspectRatio: stageAspect, perspective: '2400px' }}
        >
          {/* ---- The settled spread ---- */}
          <div
            className={`absolute inset-0 flex ${flipping ? 'pointer-events-none' : ''}`}
            style={{ transformStyle: 'preserve-3d' }}
          >
            <div className="relative h-full w-1/2">
              {slots.left !== null &&
                renderPage(slots.left, { selectable: true, isCover: false })}
            </div>
            <div className="relative h-full w-1/2">
              {slots.right !== null &&
                renderPage(slots.right, { selectable: true, isCover: slots.right === 1 })}
            </div>
          </div>

          {/* ---- The spine ---- */}
          {slots.left !== null && slots.right !== null && (
            <div
              className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-[3%] -translate-x-1/2"
              style={{
                backgroundImage:
                  'linear-gradient(to right, rgba(0,0,0,0.25), rgba(0,0,0,0.03) 40%, rgba(0,0,0,0.03) 60%, rgba(0,0,0,0.25))',
              }}
            />
          )}

          {/* ---- The turning leaf ---- */}
          <AnimatePresence>
            {flip && (
              <motion.div
                key={`${flip.front}-${flip.back}`}
                className="absolute inset-y-0 z-20 w-1/2"
                style={{
                  left: flip.direction === 'forward' ? '50%' : '0%',
                  transformStyle: 'preserve-3d',
                  transformOrigin: flip.direction === 'forward' ? 'left center' : 'right center',
                }}
                initial={{ rotateY: 0 }}
                animate={{ rotateY: flip.direction === 'forward' ? -180 : 180 }}
                transition={{ duration: TURN_DURATION, ease: TURN_EASE }}
                onAnimationComplete={() => setFlip(null)}
              >
                {/* Front: the page being turned away from. */}
                <div
                  className="absolute inset-0"
                  style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}
                >
                  {renderPage(flip.front, {
                    selectable: false,
                    isCover: flip.front === 1,
                  })}
                </div>

                {/* Back: the page being revealed. Mirrored, so it reads correctly
                    once the leaf has swung over. */}
                <div
                  className="absolute inset-0"
                  style={{
                    backfaceVisibility: 'hidden',
                    WebkitBackfaceVisibility: 'hidden',
                    transform: 'rotateY(180deg)',
                  }}
                >
                  {renderPage(flip.back, {
                    selectable: false,
                    isCover: flip.back === 1,
                  })}
                </div>

                {/* A shadow that deepens as the leaf stands upright, which is
                    what sells the paper as having thickness. */}
                <motion.div
                  className="pointer-events-none absolute inset-0 bg-black"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 0.34, 0] }}
                  transition={{ duration: TURN_DURATION, ease: 'easeInOut' }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      {/* ==================================================================
          NAVIGATION
          Arrows sit outside the paper so they never cover a page somebody
          paid for.
          ================================================================== */}
      <button
        type="button"
        onClick={() => turn('backward')}
        disabled={!canBack || flipping}
        aria-label={canBack ? `Turn back to ${viewLabel(view - 1, config.totalPages)}` : 'Already at the front page'}
        className="group absolute left-0 top-1/2 z-30 hidden -translate-y-1/2 items-center justify-center p-2 disabled:pointer-events-none disabled:opacity-0 sm:flex"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-[#dcd6ec] bg-[#faf9fe]/90 text-[#191627] shadow-md backdrop-blur transition group-hover:scale-105 group-hover:border-[#191627] dark:border-[#2a2740] dark:bg-[#131120]/90 dark:text-[#f2f0fb] dark:group-hover:border-[#f2f0fb]">
          <ChevronLeft className="h-5 w-5" />
        </span>
      </button>

      <button
        type="button"
        onClick={() => turn('forward')}
        disabled={!canForward || flipping}
        aria-label={
          canForward ? `Turn to ${viewLabel(view + 1, config.totalPages)}` : 'Already at the last page'
        }
        className="group absolute right-0 top-1/2 z-30 hidden -translate-y-1/2 items-center justify-center p-2 disabled:pointer-events-none disabled:opacity-0 sm:flex"
      >
        <span
          className={`flex h-11 w-11 items-center justify-center rounded-full border border-[#dcd6ec] bg-[#faf9fe]/90 text-[#191627] shadow-md backdrop-blur transition group-hover:scale-105 group-hover:border-[#191627] dark:border-[#2a2740] dark:bg-[#131120]/90 dark:text-[#f2f0fb] dark:group-hover:border-[#f2f0fb] ${
            view === 0 ? 'animate-pulse-subtle' : ''
          }`}
        >
          <ChevronRight className="h-5 w-5" />
        </span>
      </button>

      {/* Position, and a tappable target for phones where the edge arrows are
          hidden. */}
      <div className="mt-4 hidden items-center justify-center gap-3 sm:flex">
        <button
          type="button"
          onClick={() => turn('backward')}
          disabled={!canBack || flipping}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[#dcd6ec] bg-[#faf9fe] text-[#191627] disabled:opacity-30 dark:border-[#2a2740] dark:bg-[#131120] dark:text-[#f2f0fb] sm:hidden"
          aria-label="Previous pages"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2" role="tablist" aria-label="Newspaper pages">
          {views.map((_, index) => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={index === view}
              aria-label={viewLabel(index, config.totalPages)}
              disabled={flipping}
              onClick={() => {
                if (index === view || flipping) return;
                // A jump of more than one turn animates the first turn and
                // settles on the destination, rather than pretending to
                // riffle through every leaf.
                turn(index > view ? 'forward' : 'backward');
              }}
              className={`h-1.5 rounded-full transition-all ${
                index === view
                  ? 'w-8 bg-[#7c3aed] dark:bg-[#a78bfa]'
                  : 'w-4 bg-[#191627]/20 hover:bg-[#191627]/40 dark:bg-white/20 dark:hover:bg-white/40'
              }`}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={() => turn('forward')}
          disabled={!canForward || flipping}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[#dcd6ec] bg-[#faf9fe] text-[#191627] disabled:opacity-30 dark:border-[#2a2740] dark:bg-[#131120] dark:text-[#f2f0fb] sm:hidden"
          aria-label="Next pages"
        >
          <ChevronRight className="h-4 w-4" />
        </button>

        <span className="ml-1 font-data text-[10px] font-bold uppercase tracking-[0.25em] text-[#6f6a80] dark:text-[#a49eb6]">
          {viewLabel(view, config.totalPages)}
        </span>

        {/* Focus mode is a reading feature — buying needs the pricing panel this
            would hide, so the button is offered in reading mode only. */}
        {onToggleImmersive && !isSelectMode && (
          <button
            type="button"
            onClick={onToggleImmersive}
            aria-label={immersive ? 'Exit focus mode' : 'Enter focus mode'}
            title={immersive ? 'Exit focus mode' : 'Focus mode — hide everything but the paper'}
            className="ml-1 flex h-9 w-9 items-center justify-center rounded-full border border-[#dcd6ec] bg-[#faf9fe] text-[#191627] transition hover:border-[#191627] dark:border-[#2a2740] dark:bg-[#131120] dark:text-[#f2f0fb] dark:hover:border-[#f2f0fb]"
          >
            {immersive ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* On phones, one page at a time keeps the publication readable. The
          desktop spread remains the richer physical turn experience above. */}
      <div className="mx-auto w-full max-w-[520px] px-3 sm:hidden">
        <div
          className="relative w-full overflow-hidden"
          style={{ aspectRatio: `${config.pageWidth} / ${config.pageHeight}` }}
          onTouchStart={(event) => {
            if (isSelectMode || event.touches.length > 1) {
              touchStart.current = null;
              return;
            }
            const t = event.touches[0];
            touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
          }}
          onTouchEnd={(event) => {
            const start = touchStart.current;
            const t = event.changedTouches[0];
            touchStart.current = null;
            if (!start || !t) return;

            const dx = t.clientX - start.x;
            const dy = t.clientY - start.y;
            if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
            turnMobile(dx < 0 ? 'forward' : 'backward');
          }}
        >
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={mobilePage}
              className="absolute inset-0"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
            >
              {renderPage(mobilePage, { selectable: true, isCover: mobilePage === 1 })}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => turnMobile('backward')}
            disabled={mobilePage === 1}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#dcd6ec] bg-[#faf9fe] text-[#191627] disabled:opacity-30 dark:border-[#2a2740] dark:bg-[#131120] dark:text-[#f2f0fb]"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          <div className="min-w-0 text-center" aria-live="polite">
            <div className="font-data text-[10px] font-bold uppercase tracking-[0.2em] text-[#6f6a80] dark:text-[#a49eb6]">
              Page {mobilePage} of {config.totalPages}
            </div>
            <div className="mt-0.5 font-editorial text-[10px] italic text-[#6f6a80] dark:text-zinc-500">
              Swipe to turn the page
            </div>
          </div>

          <button
            type="button"
            onClick={() => turnMobile('forward')}
            disabled={mobilePage === config.totalPages}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#dcd6ec] bg-[#faf9fe] text-[#191627] disabled:opacity-30 dark:border-[#2a2740] dark:bg-[#131120] dark:text-[#f2f0fb]"
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
