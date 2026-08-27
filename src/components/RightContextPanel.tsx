/**
 * THE PRICING PANEL
 * =================
 *
 * What a space costs, and why.
 *
 * Every number on this panel comes from the `PricingConfig` the server sent at
 * startup. None of it is written into this file. That is not tidiness for its own
 * sake: the multipliers are meant to be adjustable from one place in
 * `shared/pricing-config.ts`, and a hardcoded "Top right 1.50×" in a sidebar is
 * how a site ends up quoting one rate and charging another. Change the config and
 * this panel changes with it.
 */

import React, { useMemo } from 'react';
import { ArrowRight, Info, Map, MousePointerClick } from 'lucide-react';

import type { PricingConfig } from '../../shared/pricing-config.ts';
import type { NewspaperStats, PixelSelection } from '../types.ts';
import { isBelowMinimum, pixels as fmtPixels, rate as fmtRate, usd } from '../lib/selection.ts';

interface RightContextPanelProps {
  config: PricingConfig;
  stats: NewspaperStats;
  selection: PixelSelection | null;
  isSelectMode: boolean;
  showPriceMap: boolean;
  onTogglePriceMap: () => void;
  onOpenCreator: () => void;
  onEnterSelectMode: () => void;
  onClearSelection: () => void;
}

export const RightContextPanel: React.FC<RightContextPanelProps> = ({
  config,
  stats,
  selection,
  isSelectMode,
  showPriceMap,
  onTogglePriceMap,
  onOpenCreator,
  onEnterSelectMode,
  onClearSelection,
}) => {
  const tooSmall = selection ? isBelowMinimum(config, selection) : false;

  const pageEntries = useMemo(
    () =>
      Object.entries(config.pageMultipliers)
        .map(([page, multiplier]) => ({ page: Number(page), multiplier }))
        .sort((a, b) => a.page - b.page),
    [config.pageMultipliers]
  );

  return (
    <aside className="w-full border-l border-[#dcd6ec] bg-[#faf8ff] dark:border-[#232037] dark:bg-[#100e18] lg:w-60">
      <div className="space-y-5 p-4 lg:p-5">
        {/* ---- Price map: an overview tool, kept apart from the buy card ---- */}
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={onTogglePriceMap}
            aria-pressed={showPriceMap}
            className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-xs border px-3 py-2.5 font-data text-[11px] font-black uppercase tracking-wider transition-colors ${
              showPriceMap
                ? 'accent-button border-transparent'
                : 'border-[#dcd6ec] bg-white text-[#191627] hover:border-[#7c3aed] dark:border-[#2a2740] dark:bg-[#171526] dark:text-[#f2f0fb] dark:hover:border-[#a78bfa]'
            }`}
          >
            <span className="flex items-center gap-2">
              <Map className="h-3.5 w-3.5" />
              <span>{showPriceMap ? 'Hide price map' : 'Show price map'}</span>
            </span>
            <span className="text-[9px] opacity-80">{showPriceMap ? 'On' : 'Off'}</span>
          </button>
          <p className="px-1 font-editorial text-[10px] leading-snug text-[#6f6a80] dark:text-zinc-500">
            Shows inventory selection over the logical page grid. V1 price is page tier plus unit count.
          </p>
        </div>

        {/* ================================================================
            YOUR SELECTION
            ================================================================ */}
        {selection ? (
          <section className="space-y-3 rounded-xs border-2 border-[#2563eb] bg-white p-3.5 dark:border-[#60a5fa] dark:bg-[#131120]">
            <header className="flex items-center justify-between">
              <h2 className="font-data text-[10px] font-black uppercase tracking-wider text-[#2563eb] dark:text-[#60a5fa]">
                Your selection
              </h2>
              <button
                type="button"
                onClick={onClearSelection}
                className="cursor-pointer font-data text-[10px] text-zinc-500 underline hover:text-black dark:hover:text-white"
              >
                Clear
              </button>
            </header>

            <dl className="space-y-1.5 font-data text-[11px]">
              {(
                [
                  ['Dimensions', `${selection.width} × ${selection.height} units`],
                  ['Pixel Units', fmtPixels(selection.quote.pixelCount)],
                  ['Position', `(${selection.x}, ${selection.y})`],
                  ['Base rate', `${fmtRate(selection.quote.baseRate)} / unit`],
                  ['Page', `${selection.pageNumber} — ×${selection.quote.pageMultiplier.toFixed(2)}`],
                  ['Position pricing', 'Not used in V1'],
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="text-[#6f6a80] dark:text-zinc-500">{label}</dt>
                  <dd className="text-right font-bold text-[#191627] dark:text-zinc-200">
                    {value}
                  </dd>
                </div>
              ))}

              <div className="flex justify-between gap-2 border-t border-[#e0dcf0] pt-1.5 dark:border-[#2a2740]">
                <dt className="font-bold text-[#2563eb] dark:text-[#60a5fa]">Effective rate</dt>
                <dd className="font-bold text-[#2563eb] dark:text-[#60a5fa]">
                  {fmtRate(selection.quote.effectiveRate)} / unit
                </dd>
              </div>
            </dl>

            {tooSmall ? (
              <div className="rounded-xs bg-[#fef3c7] p-2.5 text-center font-data text-[11px] font-bold text-[#92400e] dark:bg-[#78350f]/50 dark:text-[#fcd34d]">
                Drag out at least {config.minSelectionWidth} × {config.minSelectionHeight} units.
              </div>
            ) : (
              <>
                <div className="rounded-xs border-2 border-emerald-600 bg-emerald-50 p-3 text-center dark:border-emerald-500 dark:bg-emerald-950/60">
                  <div className="font-headline text-3xl font-black leading-none text-emerald-700 dark:text-emerald-400">
                    {usd(selection.quote.totalPrice)}
                  </div>
                  <div className="mt-1 font-data text-[9px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                    {selection.serverConfirmed ? 'Confirmed by the server' : 'Estimate'}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onOpenCreator}
                  className="accent-button flex w-full cursor-pointer items-center justify-center gap-2 rounded-xs px-4 py-3 font-ui text-xs font-black uppercase tracking-wider text-white shadow-lg transition-all hover:scale-[1.02]"
                >
                  <span>Create your ad</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </section>
        ) : (
          <section className="rounded-xs border border-dashed border-[#dcd6ec] bg-white p-4 text-center dark:border-[#2a2740] dark:bg-[#131120]">
            <MousePointerClick className="mx-auto mb-2 h-6 w-6 text-[#6f6a80] dark:text-zinc-500" />
            <h2 className="font-headline text-base font-black uppercase tracking-tight text-[#191627] dark:text-white">
              Claim a piece of Pixel Press
            </h2>
            <p className="mt-1 font-editorial text-xs leading-snug text-[#514c62] dark:text-[#a49eb6]">
              Choose available newspaper space. Add your identity. Become part of the paper.
            </p>

            {!isSelectMode && (
              <button
                type="button"
                onClick={onEnterSelectMode}
                className="accent-button mt-3 w-full cursor-pointer rounded-xs px-4 py-2.5 font-ui text-[11px] font-black uppercase tracking-wider text-white transition-transform hover:scale-[1.02]"
              >
                Pick a space
              </button>
            )}

            {isSelectMode && (
              <p className="mt-3 rounded-xs bg-[#f0edfa] p-2 font-data text-[10px] text-[#514c62] dark:bg-[#171526] dark:text-zinc-400">
                Drag anywhere on the page to draw your logical Pixel Unit space.
                {/* A page pixel is a fraction of a millimetre wide on a phone,
                    so say outright that zooming is available — and that while a
                    drag means "draw", the arrows are what change the page. */}
                <span className="lg:hidden">
                  {' '}
                  Pinch to zoom in first for a precise edge, and use the arrows to change page.
                </span>
              </p>
            )}
          </section>
        )}

        {/* ================================================================
            HOW IT WORKS
            ================================================================ */}
        <section className="space-y-2">
          <h2 className="font-data text-[10px] font-black uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
            How it works
          </h2>
          <ol className="space-y-2">
            {[
              'Choose a page or spread and draw a rectangular space.',
              'Add your logo, brand name, category and website.',
              'Review the server-calculated price and continue to payment.',
              'After verified payment and moderation, your placement appears.',
            ].map((text, index) => (
              <li key={index} className="flex gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#191627] font-data text-[9px] font-black text-white dark:bg-[#f2f0fb] dark:text-[#191627]">
                  {index + 1}
                </span>
                <span className="font-editorial text-[11px] leading-snug text-[#514c62] dark:text-[#a49eb6]">
                  {text}
                </span>
              </li>
            ))}
          </ol>
        </section>

        {/* ================================================================
            WHAT MOVES THE PRICE
            ================================================================ */}
        <section className="space-y-2.5 rounded-xs bg-[#f0edfa] p-3 dark:bg-[#171526]">
          <h2 className="flex items-center gap-1.5 font-data text-[10px] font-black uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
            <Info className="h-3 w-3" />
            <span>What moves the price</span>
          </h2>

          <p className="font-editorial text-[11px] leading-snug text-[#514c62] dark:text-[#a49eb6]">
            Every Pixel Unit starts at {fmtRate(config.baseRate)}. Page or spread tier is the only
            multiplier in V1. What you advertise makes no difference at all.
          </p>

          <div>
            <div className="mb-1 font-data text-[9px] font-black uppercase tracking-wider text-[#191627] dark:text-zinc-300">
              By page
            </div>
            <div className="grid grid-cols-3 gap-1">
              {pageEntries.map(({ page, multiplier }) => (
                <div
                  key={page}
                  className="rounded-xs border border-[#e0dcf0] bg-white px-1.5 py-1 text-center font-data dark:border-[#2a2740] dark:bg-[#131120]"
                >
                  <div className="text-[9px] text-[#6f6a80] dark:text-zinc-500">P{page}</div>
                  <div className="text-[10px] font-bold text-[#191627] dark:text-zinc-200">
                    ×{multiplier.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p className="font-editorial text-[10px] leading-snug text-[#6f6a80] dark:text-zinc-500">
            Exact visual position does not change price in V1; availability still depends on
            whether the selected logical rectangle overlaps held or sold inventory.
          </p>
        </section>

        <footer className="border-t border-[#e0dcf0] pt-3 text-center font-data text-[9px] uppercase tracking-[0.2em] text-[#6f6a80] dark:border-[#2a2740] dark:text-zinc-600">
          {config.totalPages} pages · {fmtPixels(stats.totalPixels)} units ·{' '}
          {fmtPixels(stats.claimedPixels)} claimed
        </footer>
      </div>
    </aside>
  );
};
