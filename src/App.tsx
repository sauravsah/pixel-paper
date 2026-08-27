/**
 * PIXEL PAPER
 * ===========
 *
 * The shell. It holds the four pieces of state the whole interface turns on —
 * which view is open, whether the reader is buying or reading, what rectangle is
 * selected, and what the server last said about the paper — and hands them down.
 *
 * WHAT THIS COMPONENT IS NOT ALLOWED TO DECIDE
 * -------------------------------------------
 * Two things, and they are the two that matter.
 *
 * It does not decide what a space costs. A rectangle gets a local price while the
 * pointer is moving so the number keeps up with the cursor, and on release that
 * figure is thrown away and replaced with the server's. They are computed by the
 * same module so they agree, but only one of them is going to be charged, and it
 * is not this one.
 *
 * It does not decide that anything has been paid for. There is no state here that
 * could be flipped to make a booking look complete. Returning from checkout puts a
 * booking id in the URL, and all that buys you is the right to ask the server what
 * happened — which is what `ClaimedConfirmation` spends its time doing.
 *
 * Availability is the same story. The occupied areas below are what the server
 * last reported, refreshed on a timer and whenever the tab is focused again, and
 * they exist so the cursor behaves sensibly. The rectangle is genuinely yours only
 * once a locked transaction on the server says so.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Menu, RefreshCw, Sparkles, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import type {
  NewspaperState,
  PixelSelection,
  PlacedAd,
  Rect,
  SiteConfig,
} from './types.ts';
import { ApiError } from './types.ts';
import { fetchConfig, fetchNewspaper, postQuote } from './lib/api.ts';
import { firstBlocker, usd } from './lib/selection.ts';
import { buildDemoPaper, DEMO_PAGE } from './lib/demoPaper.ts';
import { AboutView } from './components/AboutView.tsx';
import { AdCreatorModal } from './components/AdCreatorModal.tsx';
import { AdDetailModal } from './components/AdDetailModal.tsx';
import { Broadsheet, viewForPage } from './components/Broadsheet.tsx';
import { ClaimedConfirmation } from './components/ClaimedConfirmation.tsx';
import { ModernSidebar } from './components/ModernSidebar.tsx';
import { PixelMark, PixelWordmark } from './components/PixelMark.tsx';
import { RightContextPanel } from './components/RightContextPanel.tsx';
import { ThemeSwitcher } from './components/ThemeSwitcher.tsx';

/** How often to re-ask what is claimed. Pending holds expire on their own. */
const REFRESH_MS = 30_000;

/** Focus-mode enter/leave feel, echoing the paper-turn easing in Broadsheet. */
const FOCUS_DURATION = 0.3;
const FOCUS_EASE = [0.35, 0, 0.15, 1] as const;

// ---------------------------------------------------------------------------
// Arriving with something in the URL
// ---------------------------------------------------------------------------

/**
 * Read once, at module load, before React mounts anything.
 *
 * Deliberately not done inside the component: development runs mount twice, and
 * a URL that has already been tidied away would read as a plain visit the second
 * time round.
 */
interface Entry {
  /** Back from a completed checkout form. Proof of nothing; a question to ask. */
  bookingId: string | null;
  /** Back from abandoning checkout. Nothing was charged. */
  cancelled: boolean;
  /** A shared link to somebody's claimed space. */
  spaceId: string | null;
}

function readEntry(): Entry {
  if (typeof window === 'undefined') {
    return { bookingId: null, cancelled: false, spaceId: null };
  }

  const params = new URLSearchParams(window.location.search);
  const checkout = params.get('checkout');

  return {
    bookingId: checkout === 'success' ? params.get('booking') : null,
    cancelled: checkout === 'cancelled',
    spaceId: params.get('space'),
  };
}

const ENTRY = readEntry();

interface Notice {
  tone: 'info' | 'warn';
  text: string;
}

function sameRect(a: Rect & { pageNumber: number }, b: Rect & { pageNumber: number }): boolean {
  return (
    a.pageNumber === b.pageNumber &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

// ---------------------------------------------------------------------------

export default function App() {
  // ---- What the server says -----------------------------------------------
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [paper, setPaper] = useState<NewspaperState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  // ---- What the reader is doing --------------------------------------------
  const [view, setView] = useState(0);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [showPriceMap, setShowPriceMap] = useState(false);
  const [selection, setSelection] = useState<PixelSelection | null>(null);

  // ---- Chrome and overlays ------------------------------------------------
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isCreatorOpen, setIsCreatorOpen] = useState(false);
  const [detailAd, setDetailAd] = useState<PlacedAd | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // Focus mode: the paper takes over the whole window and all chrome hides behind
  // it. Just a flag — see the overlay near the other overlays below.
  const [isImmersive, setIsImmersive] = useState(false);
  // A client-only preview: fill every page with example ads, touching nothing
  // on the server. See `handleToggleDemo` and `activePaper`.
  const [demoMode, setDemoMode] = useState(false);

  // ---- Arrivals from elsewhere -------------------------------------------
  const [bookingId, setBookingId] = useState<string | null>(ENTRY.bookingId);
  const [pendingSpaceId, setPendingSpaceId] = useState<string | null>(ENTRY.spaceId);
  const [notice, setNotice] = useState<Notice | null>(
    ENTRY.cancelled
      ? {
          tone: 'info',
          text: 'Checkout cancelled. Nothing was charged and the space is back on the page.',
        }
      : null
  );

  // Honour the OS "reduce motion" setting for the focus-mode transition.
  const reduceMotion = useReducedMotion();

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  const refreshPaper = useCallback(async () => {
    try {
      setPaper(await fetchNewspaper());
    } catch {
      // Keep showing what we already have. The timer will try again, and a stale
      // read of who owns what is harmless here — the server settles it at
      // checkout regardless of what this browser believes.
    }
  }, []);

  useEffect(() => {
    let abandoned = false;

    void (async () => {
      try {
        const [nextConfig, nextPaper] = await Promise.all([fetchConfig(), fetchNewspaper()]);
        if (abandoned) return;
        setConfig(nextConfig);
        setPaper(nextPaper);
      } catch (error) {
        if (abandoned) return;
        setFatal(
          error instanceof ApiError
            ? error.message
            : 'Could not load the newspaper. Is the server running?'
        );
      }
    })();

    return () => {
      abandoned = true;
    };
  }, []);

  /** Keep availability roughly current without hammering the server. */
  useEffect(() => {
    if (!config) return;

    const timer = window.setInterval(() => void refreshPaper(), REFRESH_MS);
    const onFocus = () => void refreshPaper();
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [config, refreshPaper]);

  /** Tidy the query string so a refresh is a plain visit. */
  useEffect(() => {
    if (!ENTRY.bookingId && !ENTRY.cancelled && !ENTRY.spaceId) return;
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  /** A shared link: find the space, turn to its page, open it. */
  useEffect(() => {
    if (!pendingSpaceId || !paper) return;
    setPendingSpaceId(null);

    const ad = paper.ads.find((candidate) => candidate.bookingId === pendingSpaceId);
    if (!ad) {
      setNotice({ tone: 'warn', text: 'That space could not be found.' });
      return;
    }

    setView(viewForPage(ad.pageNumber));
    setDetailAd(ad);
  }, [pendingSpaceId, paper]);

  /** Notices are transient by nature. */
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /**
   * Called on pointer release. Replaces the locally computed price with the
   * server's, and finds out whether the area is actually free.
   */
  const handleSelectionCommit = useCallback(
    async (candidate: PixelSelection) => {
      try {
        const result = await postQuote(candidate.pageNumber, {
          x: candidate.x,
          y: candidate.y,
          width: candidate.width,
          height: candidate.height,
        });

        if (result.available === false) {
          // Someone got there first, or a checkout is holding it. Clearing is
          // kinder than leaving a rectangle that is going to be refused.
          setSelection((current) =>
            current && sameRect(current, candidate) ? null : current
          );
          setNotice({
            tone: 'warn',
            text: 'Part of that area has just been claimed. Try somewhere else.',
          });
          void refreshPaper();
          return;
        }

        setSelection((current) => {
          // The reader may have started another rectangle while this was in
          // flight. Only the one that was asked about gets the answer.
          if (!current || !sameRect(current, candidate)) return current;
          return { ...current, quote: result.quote, serverConfirmed: true };
        });
      } catch (error) {
        // The local estimate stays on screen, still marked as an estimate. It is
        // the checkout call that has to succeed, not this one.
        setNotice({
          tone: 'warn',
          text:
            error instanceof ApiError && error.code === 'network'
              ? 'Lost contact with the server, so that price is still an estimate.'
              : 'Could not confirm that price with the server yet.',
        });
      }
    },
    [refreshPaper]
  );

  const handleModeChange = useCallback((selectMode: boolean) => {
    setIsSelectMode(selectMode);
    setIsAboutOpen(false);
    // Buying is done against the real paper, never the demo's invented ads.
    if (selectMode) setDemoMode(false);
    // A blue rectangle sitting on the page in reading mode is just confusing.
    if (!selectMode) setSelection(null);
  }, []);

  const handleEnterSelectMode = useCallback(() => handleModeChange(true), [handleModeChange]);

  /** Enter or leave focus mode. Closing the drawer keeps a stray mobile menu from
   *  floating over the takeover. */
  const handleToggleImmersive = useCallback(() => {
    setIsImmersive((on) => !on);
    setIsDrawerOpen(false);
  }, []);

  /** Escape leaves focus mode, mirroring the modal-close convention. */
  useEffect(() => {
    if (!isImmersive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsImmersive(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isImmersive]);

  /**
   * Fill the paper with example ads, or clear them again. Turning it on returns
   * to reading mode with nothing selected, so the populated pages are exactly
   * what the reader sees. It writes nothing to the server; flipping it back off
   * shows the live paper again.
   */
  const handleToggleDemo = useCallback(() => {
    setDemoMode((on) => {
      const next = !on;
      if (next) {
        setIsSelectMode(false);
        setSelection(null);
        setIsAboutOpen(false);
        // Bring the reader to the one page the demo fills.
        setView(viewForPage(DEMO_PAGE));
        setNotice({
          tone: 'info',
          text: 'Demo mode: these ads are examples, not real bookings. Turn it off for the live paper.',
        });
      }
      return next;
    });
  }, []);

  const handleOpenCreator = useCallback(() => {
    if (!selection) return;
    setIsCreatorOpen(true);
  }, [selection]);

  /**
   * Closing the form. If the area was claimed by someone else while it was open,
   * drop the selection rather than leave a rectangle drawn over other people's
   * pixels.
   */
  const handleCloseCreator = useCallback(() => {
    setIsCreatorOpen(false);
    setSelection((current) => {
      if (!current || !paper) return current;
      const onThisPage = paper.occupied.filter((area) => area.pageNumber === current.pageNumber);
      return firstBlocker(current, onThisPage) ? null : current;
    });
  }, [paper]);

  const handleViewSpace = useCallback(
    (pageNumber: number) => {
      setBookingId(null);
      setIsCreatorOpen(false);
      setIsAboutOpen(false);
      setIsSelectMode(false);
      setSelection(null);
      setView(viewForPage(pageNumber));
      void refreshPaper();
    },
    [refreshPaper]
  );

  const handleDismissConfirmation = useCallback(() => {
    setBookingId(null);
    setIsCreatorOpen(false);
    setSelection(null);
    void refreshPaper();
  }, [refreshPaper]);

  // -------------------------------------------------------------------------
  // What the server is missing, if anything
  // -------------------------------------------------------------------------

  const setupNotes = useMemo(() => {
    if (!config) return [];
    const notes: { key: string; consequence: string }[] = [];

    if (!config.readiness.database) {
      notes.push({
        key: 'DATABASE_URL',
        consequence: 'nothing can be booked, because there is nowhere to record it',
      });
    }
    if (!config.readiness.payments) {
      notes.push({ key: 'DODO_PAYMENTS_API_KEY', consequence: 'checkout cannot start' });
    }
    if (!config.readiness.webhook) {
      notes.push({
        key: 'DODO_PAYMENTS_WEBHOOK_KEY',
        consequence: 'payments can be taken but never confirmed, so no space would go live',
      });
    }

    return notes;
  }, [config]);

  const liveKeyWarning = Boolean(
    config && config.readiness.payments && !config.readiness.testMode
  );

  /** The invented, fully-packed paper shown while demo mode is on. */
  const demoPaper = useMemo(
    () => (config ? buildDemoPaper(config.pricing) : null),
    [config]
  );

  // -------------------------------------------------------------------------
  // Loading and failure
  // -------------------------------------------------------------------------

  if (fatal) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#f2effb] p-6 text-center text-[#191627] dark:bg-[#0b0a14] dark:text-[#f2f0fb]">
        <AlertTriangle className="h-10 w-10 text-[#7c3aed] dark:text-[#a78bfa]" />
        <PixelWordmark size="text-3xl" />
        <p className="max-w-md font-editorial text-sm text-[#514c62] dark:text-[#a49eb6]">{fatal}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex cursor-pointer items-center gap-2 rounded-xs bg-[#191627] px-5 py-2.5 font-ui text-xs font-black uppercase tracking-wider text-white dark:bg-[#f2f0fb] dark:text-[#191627]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Try again</span>
        </button>
      </div>
    );
  }

  if (!config || !paper) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#f2effb] text-[#191627] dark:bg-[#0b0a14] dark:text-[#f2f0fb]">
        <PixelMark size={56} className="pp-glow rounded-lg" />
        <PixelWordmark size="text-2xl sm:text-4xl" />
        <Loader2 className="h-6 w-6 animate-spin text-[#7c3aed] dark:text-[#a78bfa]" />
        <p className="font-data text-[10px] uppercase tracking-[0.3em] text-[#6f6a80] dark:text-zinc-500">
          Opening the paper
        </p>
      </div>
    );
  }

  const pricing = config.pricing;

  // What the paper renders from: the demo's invented ads while demo mode is on,
  // otherwise whatever the server last reported. Only presentation reads this;
  // the buy flow and shared links still go through the real `paper`.
  const activePaper = demoMode && demoPaper ? demoPaper : paper;

  const panel = (
    <RightContextPanel
      config={pricing}
      stats={activePaper.stats}
      selection={selection}
      isSelectMode={isSelectMode}
      showPriceMap={showPriceMap}
      onTogglePriceMap={() => setShowPriceMap((on) => !on)}
      onOpenCreator={handleOpenCreator}
      onEnterSelectMode={handleEnterSelectMode}
      onClearSelection={() => setSelection(null)}
    />
  );

  return (
    <div className="flex min-h-screen flex-col bg-[#f2effb] font-ui text-[#191627] transition-colors duration-200 selection:bg-[#7c3aed] selection:text-white dark:bg-[#0b0a14] dark:text-[#f2f0fb] dark:selection:bg-[#a78bfa]">
      {/* ==================================================================
          MASTHEAD BAR
          ================================================================== */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-[#dcd6ec] bg-[#faf9fe]/95 px-3 py-2.5 backdrop-blur-md transition-colors duration-200 dark:border-[#232037] dark:bg-[#131120]/95 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={() => setIsDrawerOpen((open) => !open)}
            className="cursor-pointer p-1.5 text-[#514c62] hover:text-[#191627] dark:text-zinc-400 dark:hover:text-white lg:hidden"
            aria-label={isDrawerOpen ? 'Close menu' : 'Open menu'}
          >
            {isDrawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>

          <button
            type="button"
            onClick={() => {
              setIsAboutOpen(false);
              setView(0);
            }}
            className="group flex min-w-0 cursor-pointer items-center gap-2.5"
          >
            <PixelMark
              size={30}
              className="shrink-0 transition-transform group-hover:scale-110"
              aria-hidden
            />
            <PixelWordmark size="text-base sm:text-lg" />
          </button>
        </div>

        <div className="hidden items-center gap-4 font-data text-xs md:flex">
          <span className="flex items-center gap-1.5 rounded-xs border border-[#dcd6ec] bg-[#efebfa] px-2.5 py-1 dark:border-[#2a2740] dark:bg-[#1b1826]">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
            <span className="font-bold text-[#191627] dark:text-white">
              Permanent digital newspaper
            </span>
          </span>
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#6f6a80] dark:text-zinc-400">
            {isSelectMode ? 'Pixel canvas' : 'Reading mode'}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={handleToggleDemo}
            aria-pressed={demoMode}
            title="Preview the paper filled with example ads"
            className={`hidden cursor-pointer items-center gap-1.5 rounded-xs px-3 py-1.5 font-ui text-xs font-black uppercase tracking-wider shadow-sm transition-all duration-200 sm:flex ${
              demoMode
                ? 'accent-button text-white'
                : 'border border-[#dcd6ec] bg-white text-[#191627] hover:border-[#7c3aed] dark:border-[#2a2740] dark:bg-[#171526] dark:text-[#f2f0fb] dark:hover:border-[#a78bfa]'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>{demoMode ? 'Exit demo' : 'Demo'}</span>
          </button>

          <button
            type="button"
            onClick={() => handleModeChange(!isSelectMode)}
            className={`flex cursor-pointer items-center gap-1.5 rounded-xs px-3 py-1.5 font-ui text-xs font-black uppercase tracking-wider shadow-sm transition-all duration-200 ${
              isSelectMode
                ? 'accent-button text-white'
                : 'bg-[#191627] text-[#faf9fe] hover:bg-black dark:bg-[#f2f0fb] dark:text-[#131120] dark:hover:bg-white'
            }`}
          >
            {isSelectMode ? 'Read the paper' : 'Buy a space'}
          </button>

          <ThemeSwitcher />
        </div>
      </header>

      {/* ==================================================================
          SETUP BANNER — names the exact variable, and nothing else
          ================================================================== */}
      {setupNotes.length > 0 && !bannerDismissed && (
        <div className="flex items-start gap-3 border-b border-amber-300 bg-amber-100 px-4 py-2.5 text-left dark:border-amber-900 dark:bg-amber-950/70">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="font-data text-[11px] font-black uppercase tracking-wider text-amber-900 dark:text-amber-300">
              Not ready to sell yet
            </p>
            {setupNotes.map((note) => (
              <p
                key={note.key}
                className="font-editorial text-xs leading-snug text-amber-900 dark:text-amber-200"
              >
                <code className="font-data font-bold">{note.key}</code> is missing, so{' '}
                {note.consequence}.
              </p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setBannerDismissed(true)}
            className="shrink-0 cursor-pointer p-1 text-amber-800 hover:text-amber-950 dark:text-amber-400 dark:hover:text-amber-200"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {liveKeyWarning && !bannerDismissed && (
        <div className="flex items-center gap-2 border-b border-[#7c3aed] bg-[#7c3aed] px-4 py-2 font-data text-[11px] font-bold uppercase tracking-wider text-white dark:border-[#a78bfa] dark:bg-[#a78bfa]">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Dodo is in live mode. Real cards will be charged.</span>
        </div>
      )}

      {/* ==================================================================
          THE PAPER
          ================================================================== */}
      <div className="flex min-h-0 flex-1 lg:overflow-hidden">
        <ModernSidebar
          view={view}
          onViewChange={setView}
          isSelectMode={isSelectMode}
          onModeChange={handleModeChange}
          config={pricing}
          stats={activePaper.stats}
          isAboutOpen={isAboutOpen}
          onToggleAbout={() => setIsAboutOpen((open) => !open)}
          isDrawerOpen={isDrawerOpen}
          onCloseDrawer={() => setIsDrawerOpen(false)}
        />

        <main className="flex min-h-0 flex-1 flex-col lg:overflow-y-auto">
          <div className="flex w-full flex-1 flex-col items-center p-3 sm:p-4 lg:px-3 lg:py-6">
            {isAboutOpen ? (
              <AboutView
                config={pricing}
                onStartBuying={() => {
                  setIsAboutOpen(false);
                  setIsSelectMode(true);
                }}
                onBack={() => setIsAboutOpen(false)}
              />
            ) : isImmersive ? null : (
              <div className="flex w-full max-w-[1600px] flex-col items-center gap-4">
                <Broadsheet
                  view={view}
                  onViewChange={setView}
                  config={pricing}
                  priceMap={config.priceMap}
                  ads={activePaper.ads}
                  occupied={activePaper.occupied}
                  isSelectMode={isSelectMode}
                  showPriceMap={showPriceMap}
                  selection={selection}
                  onSelectionChange={setSelection}
                  onSelectionCommit={(next) => void handleSelectionCommit(next)}
                  onAdClick={setDetailAd}
                  immersive={false}
                  onToggleImmersive={handleToggleImmersive}
                />
              </div>
            )}
          </div>

          {/* On a narrow screen the pricing panel follows the paper instead of
              squeezing it into a column too thin to read. */}
          {!isAboutOpen && (
            <div className="w-full border-t border-[#dcd6ec] dark:border-[#232037] lg:hidden">
              {panel}
            </div>
          )}
        </main>

        <div className="hidden shrink-0 overflow-y-auto lg:block">{panel}</div>
      </div>

      {/* ==================================================================
          A SELECTION, ALWAYS REACHABLE ON MOBILE
          ================================================================== */}
      {selection && !isCreatorOpen && !bookingId && (
        <div className="sticky bottom-0 z-30 flex items-center justify-between gap-3 border-t-2 border-[#191627] bg-[#faf9fe] px-4 py-2.5 shadow-[0_-4px_16px_rgba(0,0,0,0.12)] dark:border-[#332f45] dark:bg-[#131120] lg:hidden">
          <div className="min-w-0">
            <div className="font-data text-[10px] uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
              {selection.width} × {selection.height} Pixel Units · page {selection.pageNumber}
            </div>
            <div className="font-headline text-xl font-black leading-none text-[#191627] dark:text-white">
              {usd(selection.quote.totalPrice)}
              <span className="ml-1.5 font-data text-[9px] font-bold uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
                {selection.serverConfirmed ? 'confirmed' : 'estimate'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={handleOpenCreator}
            disabled={
              selection.width < pricing.minSelectionWidth ||
              selection.height < pricing.minSelectionHeight
            }
            className="accent-button shrink-0 cursor-pointer rounded-xs px-4 py-2.5 font-ui text-xs font-black uppercase tracking-wider text-white shadow-lg disabled:cursor-not-allowed disabled:opacity-40"
          >
            Create your ad
          </button>
        </div>
      )}

      {/* ==================================================================
          NOTICES
          ================================================================== */}
      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4"
        >
          <div
            className={`pointer-events-auto flex max-w-md items-start gap-2 rounded-xs border-2 px-3.5 py-2.5 font-data text-xs shadow-2xl ${
              notice.tone === 'warn'
                ? 'border-[#7c3aed] bg-[#fdf1f1] text-[#7f1d1d] dark:border-[#a78bfa] dark:bg-[#2a1512] dark:text-[#fecaca]'
                : 'border-[#191627] bg-[#faf9fe] text-[#191627] dark:border-[#332f45] dark:bg-[#1b1826] dark:text-[#f2f0fb]'
            }`}
          >
            <span className="leading-snug">{notice.text}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="shrink-0 cursor-pointer opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* ==================================================================
          OVERLAYS
          ================================================================== */}
      {/* FOCUS MODE — the paper fills the window and all chrome hides behind this
          opaque, full-viewport layer. The same Broadsheet renders here (page turns,
          dots, arrows, swipe, keyboard all come along); the in-flow copy above is
          suppressed while this is up, so arrow keys turn the page exactly once. */}
      <AnimatePresence>
        {isImmersive && !isAboutOpen && (
          <motion.div
            key="focus-overlay"
            role="dialog"
            aria-label="Focus reading mode"
            className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-[#f2effb] p-4 dark:bg-[#0b0a14]"
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.985 }}
            transition={{ duration: reduceMotion ? 0 : FOCUS_DURATION, ease: FOCUS_EASE }}
          >
            <Broadsheet
              view={view}
              onViewChange={setView}
              config={pricing}
              priceMap={config.priceMap}
              ads={activePaper.ads}
              occupied={activePaper.occupied}
              isSelectMode={isSelectMode}
              showPriceMap={showPriceMap}
              selection={selection}
              onSelectionChange={setSelection}
              onSelectionCommit={(next) => void handleSelectionCommit(next)}
              onAdClick={setDetailAd}
              immersive
              onToggleImmersive={handleToggleImmersive}
            />
            <button
              type="button"
              onClick={handleToggleImmersive}
              aria-label="Exit focus mode"
              title="Exit focus mode (Esc)"
              className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-[#dcd6ec] bg-[#faf9fe]/90 text-[#514c62] opacity-70 shadow-md backdrop-blur transition hover:text-[#191627] hover:opacity-100 dark:border-[#2a2740] dark:bg-[#131120]/90 dark:text-[#a49eb6] dark:hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AdCreatorModal
        isOpen={isCreatorOpen}
        selection={selection}
        config={pricing}
        onClose={handleCloseCreator}
        onAreaLost={() => void refreshPaper()}
      />

      <AdDetailModal
        ad={detailAd}
        config={pricing}
        onClose={() => setDetailAd(null)}
        onStartBuying={handleEnterSelectMode}
      />

      {bookingId && (
        <ClaimedConfirmation
          bookingId={bookingId}
          onViewSpace={handleViewSpace}
          onDismiss={handleDismissConfirmation}
        />
      )}
    </div>
  );
}
