/**
 * THE SIDEBAR
 * ===========
 *
 * Mode, pages, and how much of the paper is gone.
 *
 * The page list is derived from the configured paper because pages 2 and 3 are
 * one spread and you cannot look at one without the other.
 *
 * There are no section names here. No "AI page", no "Startup page". A page is a
 * page; what ends up on it is whatever people bought, and sorting buyers into
 * categories would also be the first step toward charging them differently for
 * what they are rather than where they are.
 */

import React from 'react';
import { BookOpen, Info, MousePointerClick, Sparkles, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

import type { PricingConfig } from '../../shared/pricing-config.ts';
import type { NewspaperStats } from '../types.ts';
import { pixels as fmtPixels, rate as fmtRate } from '../lib/selection.ts';
import { buildViews, viewLabel } from './Broadsheet.tsx';
import { PixelMark, PixelWordmark } from './PixelMark.tsx';

interface ModernSidebarProps {
  view: number;
  onViewChange: (view: number) => void;
  isSelectMode: boolean;
  onModeChange: (selectMode: boolean) => void;
  config: PricingConfig;
  stats: NewspaperStats;
  isAboutOpen: boolean;
  onToggleAbout: () => void;
  demoMode: boolean;
  onToggleDemo: () => void;
  /** The pages/menu drawer is available at every viewport size. */
  isDrawerOpen: boolean;
  isDetailsOpen: boolean;
  isTopmost: boolean;
  onCloseDrawer: () => void;
}

const SidebarBody: React.FC<ModernSidebarProps> = ({
  view,
  onViewChange,
  isSelectMode,
  onModeChange,
  config,
  stats,
  isAboutOpen,
  onToggleAbout,
  demoMode,
  onToggleDemo,
  onCloseDrawer,
}) => {
  const claimedFraction =
    stats.totalPixels > 0 ? stats.claimedPixels / stats.totalPixels : 0;

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4 lg:p-5">
      {/* ---- Masthead ---- */}
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <PixelMark size={34} className="shrink-0" aria-hidden />
          <div className="min-w-0">
            <PixelWordmark size="text-sm" />
            <div className="mt-0.5 font-data text-[9px] uppercase tracking-[0.2em] text-[#6f6a80] dark:text-zinc-500">
              {config.totalPages} permanent pages
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onCloseDrawer}
          className="-mr-1 -mt-1 shrink-0 cursor-pointer rounded-xs p-1.5 text-[#6f6a80] hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] dark:text-zinc-400 dark:hover:bg-white/10 dark:focus-visible:ring-[#a78bfa]"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* ================================================================
          MODE
          ================================================================ */}
      <section className="space-y-2">
        <h2 className="font-data text-[9px] font-black uppercase tracking-[0.2em] text-[#6f6a80] dark:text-zinc-500">
          Mode
        </h2>
        <div className="grid grid-cols-2 gap-1 rounded-xs bg-[#ece8f8] p-1 dark:bg-[#171526]">
          {(
            [
              [false, 'Read', BookOpen],
              [true, 'Buy space', MousePointerClick],
            ] as [boolean, string, typeof BookOpen][]
          ).map(([selectMode, label, Icon]) => (
            <button
              key={label}
              type="button"
              onClick={() => onModeChange(selectMode)}
              aria-pressed={isSelectMode === selectMode}
              className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-xs px-2 py-2 font-data text-[10px] font-black uppercase tracking-wider transition-all ${
                isSelectMode === selectMode
                  ? 'bg-[#191627] text-white shadow-sm dark:bg-[#f2f0fb] dark:text-[#191627]'
                  : 'text-[#514c62] hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5'
              }`}
            >
              <Icon className="h-3 w-3" />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <p className="font-editorial text-[11px] leading-snug text-[#6f6a80] dark:text-zinc-500">
          {isSelectMode
            ? 'Drag out any rectangle on any page to price it.'
            : 'Ads on the page are live links. Click one to visit it.'}
        </p>
      </section>

      {/* ================================================================
          PAGES
          ================================================================ */}
      <section className="space-y-2">
        <h2 className="font-data text-[9px] font-black uppercase tracking-[0.2em] text-[#6f6a80] dark:text-zinc-500">
          Pages
        </h2>
        <nav className="space-y-1">
          {buildViews(config.totalPages).map((_, index) => (
            <button
              key={index}
              type="button"
              onClick={() => {
                onViewChange(index);
                onCloseDrawer();
              }}
              aria-current={index === view ? 'page' : undefined}
              className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-xs border px-3 py-2 text-left transition-all ${
                index === view
                  ? 'border-[#191627] bg-white shadow-sm dark:border-[#f2f0fb] dark:bg-[#1b1826]'
                  : 'border-transparent hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <span
                className={`font-data text-[11px] font-bold uppercase tracking-wider ${
                  index === view
                    ? 'text-[#191627] dark:text-white'
                    : 'text-[#514c62] dark:text-zinc-400'
                }`}
              >
                {viewLabel(index, config.totalPages)}
              </span>
              {index === view && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#7c3aed] dark:bg-[#a78bfa]" />
              )}
            </button>
          ))}
        </nav>
      </section>

      {/* ================================================================
          INVENTORY
          ================================================================ */}
      <section className="space-y-2">
        <h2 className="font-data text-[9px] font-black uppercase tracking-[0.2em] text-[#6f6a80] dark:text-zinc-500">
          Permanently claimed
        </h2>

        <div className="h-2 w-full overflow-hidden rounded-full bg-[#ece8f8] dark:bg-[#171526]">
          <div
            className="h-full rounded-full bg-[#7c3aed] transition-all duration-500 dark:bg-[#a78bfa]"
            // A hairline is shown for any non-zero amount, so the very first sale
            // is visible instead of rounding away to nothing.
            style={{
              width:
                claimedFraction > 0 ? `${Math.max(0.5, claimedFraction * 100)}%` : '0%',
            }}
          />
        </div>

        <dl className="space-y-1 font-data text-[10px]">
          <div className="flex justify-between gap-2">
            <dt className="text-[#6f6a80] dark:text-zinc-500">Claimed</dt>
            <dd className="font-bold text-[#191627] dark:text-zinc-200">
              {fmtPixels(stats.claimedPixels)} units
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-[#6f6a80] dark:text-zinc-500">Still available</dt>
            <dd className="font-bold text-[#191627] dark:text-zinc-200">
              {fmtPixels(Math.max(0, stats.totalPixels - stats.claimedPixels))} units
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-[#6f6a80] dark:text-zinc-500">Ads placed</dt>
            <dd className="font-bold text-[#191627] dark:text-zinc-200">
              {stats.paidBookings}
            </dd>
          </div>
          <div className="flex justify-between gap-2 border-t border-[#e0dcf0] pt-1 dark:border-[#2a2740]">
            <dt className="text-[#6f6a80] dark:text-zinc-500">From</dt>
            <dd className="font-bold text-[#191627] dark:text-zinc-200">
              {fmtRate(config.baseRate)} / unit
            </dd>
          </div>
        </dl>
      </section>

      {/* ---- Footer ---- */}
      <div className="mt-auto space-y-3 border-t border-[#e0dcf0] pt-4 dark:border-[#2a2740]">
        <button
          type="button"
          onClick={() => {
            onToggleDemo();
            onCloseDrawer();
          }}
          aria-pressed={demoMode}
          className={`flex w-full cursor-pointer items-center gap-2 rounded-xs px-3 py-2 font-data text-[10px] font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] dark:focus-visible:ring-[#a78bfa] ${
            demoMode
              ? 'accent-button text-white'
              : 'text-[#514c62] hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>{demoMode ? 'Exit preview' : 'Preview edition'}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            onToggleAbout();
            onCloseDrawer();
          }}
          className={`flex w-full cursor-pointer items-center gap-2 rounded-xs px-3 py-2 font-data text-[10px] font-bold uppercase tracking-wider transition-colors ${
            isAboutOpen
              ? 'bg-[#191627] text-white dark:bg-[#f2f0fb] dark:text-[#191627]'
              : 'text-[#514c62] hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5'
          }`}
        >
          <Info className="h-3.5 w-3.5" />
          <span>{isAboutOpen ? 'Back to the paper' : 'About'}</span>
        </button>
      </div>
    </div>
  );
};

export const ModernSidebar: React.FC<ModernSidebarProps> = (props) => (
  <>
    {/* The pages/menu drawer stays on demand so the paper owns the default surface. */}
    <AnimatePresence>
      {props.isDrawerOpen && (
        <div
          className={`pointer-events-none fixed inset-0 ${props.isTopmost ? 'z-[55]' : 'z-50'}`}
        >
          <motion.button
            type="button"
            onClick={props.onCloseDrawer}
            className={`absolute inset-0 top-24 cursor-default bg-transparent lg:top-14 ${
              props.isTopmost ? 'pointer-events-auto' : 'pointer-events-none'
            } ${props.isDetailsOpen ? 'md:left-[288px] md:right-[min(24rem,92vw)]' : ''}`}
            aria-label="Close pages menu"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="Pages menu"
            className="pointer-events-auto absolute inset-y-0 left-0 top-24 z-10 w-[288px] max-w-[88vw] border-r border-[#dcd6ec] bg-[#faf8ff] shadow-2xl dark:border-[#232037] dark:bg-[#100e18] lg:top-14"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ duration: 0.3, ease: [0.35, 0, 0.15, 1] }}
          >
            <SidebarBody {...props} />
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  </>
);
