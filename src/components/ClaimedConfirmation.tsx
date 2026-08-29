/**
 * SPACE CLAIMED
 * =============
 *
 * Where a buyer lands after paying. The payment provider sends them back here
 * with a booking id; this screen asks the server what became of it.
 *
 * WHY THIS POLLS INSTEAD OF CELEBRATING IMMEDIATELY
 * -------------------------------------------------
 * Coming back from checkout with a booking id means the buyer finished the
 * payment form. It does not mean the money moved, and it certainly is not proof
 * this browser is entitled to claim anything. The booking becomes paid when the
 * payment provider's webhook reaches our server and its signature checks out — a
 * conversation this page is not part of.
 *
 * So there is a gap, usually under a second, occasionally a few, between the
 * redirect landing and the webhook arriving. Rather than assume, this screen sits
 * in an honest "confirming" state and asks again until the server says paid. If
 * the wait runs long, it says so plainly and points out that the space is held
 * either way, because the alternative — showing a fake success and letting the
 * reader discover later that their pixels are blank — is worse than a wait.
 *
 * There is no code path here that can mark anything paid. The only thing this
 * component can do is ask.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  Share2,
} from 'lucide-react';

import type { CheckoutStatus } from '../types.ts';
import { ApiError } from '../types.ts';
import { fetchCheckoutStatus } from '../lib/api.ts';
import { displayUrl, pixels as fmtPixels, usd } from '../lib/selection.ts';

/** How long to keep asking before admitting the wait is unusual. */
const MAX_ATTEMPTS = 40;
const POLL_MS = 1500;

interface ClaimedConfirmationProps {
  bookingId: string;
  /** Take the reader to the page their space is on and close this. */
  onViewSpace: (pageNumber: number) => void;
  onDismiss: () => void;
  /** Close the confirmation and refresh inventory after an expired hold. */
  onReleased: () => void;
}

export const ClaimedConfirmation: React.FC<ClaimedConfirmationProps> = ({
  bookingId,
  onViewSpace,
  onDismiss,
  onReleased,
}) => {
  const [status, setStatus] = useState<CheckoutStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [copied, setCopied] = useState(false);
  const celebrated = useRef(false);

  const paid = status?.status === 'paid';
  const cancelled = status?.status === 'cancelled';
  const stillWaiting = !paid && !cancelled && !error;
  const takingLong = stillWaiting && attempts >= MAX_ATTEMPTS;

  // ---- Ask, and keep asking until there is an answer ----------------------
  useEffect(() => {
    if (!bookingId || paid || cancelled || takingLong) return;

    let cancelledEffect = false;

    const tick = async () => {
      try {
        const next = await fetchCheckoutStatus(bookingId);
        if (cancelledEffect) return;
        if (next.status === 'cancelled') {
          // The server cancelled this booking because its 20-minute hold
          // expired. Close immediately so the refreshed paper can be selected.
          onReleased();
          return;
        }
        setStatus(next);
        setError(null);
        if (next.status !== 'paid') setAttempts((n) => n + 1);
      } catch (err) {
        if (cancelledEffect) return;
        // A 404 here means the booking id does not match a booking — someone
        // arrived with a made-up or very old link.
        if (err instanceof ApiError && err.status === 404) {
          setError('We could not find that checkout. If you were charged, contact us and we will sort it out.');
        } else {
          setAttempts((n) => n + 1);
        }
      }
    };

    // First ask immediately; the webhook has usually already landed.
    const delay = attempts === 0 ? 0 : POLL_MS;
    const timer = window.setTimeout(tick, delay);

    return () => {
      cancelledEffect = true;
      window.clearTimeout(timer);
    };
  }, [bookingId, attempts, paid, cancelled, takingLong, onReleased]);

  // ---- A small celebration, once ------------------------------------------
  useEffect(() => {
    if (!paid || celebrated.current) return;
    celebrated.current = true;

    // Loaded on demand: nobody who is only reading the paper should pay to
    // download a confetti library.
    void import('canvas-confetti')
      .then(({ default: confetti }) => {
        confetti({ particleCount: 90, spread: 74, origin: { y: 0.3 }, disableForReducedMotion: true });
      })
      .catch(() => {
        /* A missing celebration is not a problem worth reporting. */
      });
  }, [paid]);

  const shareUrl = status
    ? `${window.location.origin}/?space=${encodeURIComponent(status.booking.id)}`
    : window.location.origin;

  const handleCopy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(shareUrl)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, [shareUrl]);

  const handleShare = useCallback(() => {
    if (!status?.ad) return;
    const text = `I just claimed a permanent space in PIXEL PAPER — ${status.booking.width} × ${status.booking.height} Pixel Units on page ${status.booking.pageNumber}.`;
    window.open(
      `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`,
      '_blank',
      'noopener,noreferrer'
    );
  }, [shareUrl, status]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/85 p-3 backdrop-blur-xs sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
    >
      <div className="relative my-auto w-full max-w-2xl rounded-xs border-4 border-[#191627] bg-[#faf9fe] p-5 text-center text-[#191627] shadow-2xl dark:border-[#332f45] dark:bg-[#131120] dark:text-[#f2f0fb] sm:p-8">
        {/* ================================================================
            PAID
            ================================================================ */}
        {paid && status && (
          <div className="space-y-6">
            <header className="space-y-1">
              <div className="mb-1 inline-flex items-center gap-1.5 rounded-xs border border-emerald-300 bg-emerald-100 px-3 py-1 font-data text-xs font-black uppercase tracking-widest text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/80 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span>Space claimed</span>
              </div>
              <h2 className="font-headline text-3xl font-black uppercase tracking-tight text-[#191627] dark:text-white sm:text-5xl">
                Your space is live.
              </h2>
              <p className="mx-auto max-w-lg font-editorial text-sm text-[#514c62] dark:text-[#a49eb6] sm:text-base">
                Page {status.booking.pageNumber} is yours at those coordinates from now on.
                Nothing to renew, nothing to expire.
              </p>
            </header>

            {/* The ad as it now appears in the paper. */}
            {status.ad && (
              <div className="mx-auto max-w-lg">
                <div
                  className="flex flex-col overflow-hidden border-2 border-[#191627] bg-[#fffeff] text-left text-[#191627] shadow-2xl dark:border-[#413c54] dark:bg-[#1a1726] dark:text-[#f2f0fb]"
                  style={{
                    aspectRatio: `${status.booking.width} / ${status.booking.height}`,
                    maxHeight: '60vh',
                  }}
                >
                  <div className="flex items-center justify-between gap-2 border-b border-current/20 px-3 py-1.5 font-data text-[11px]">
                    {status.ad.brandName && (
                      <span className="truncate font-black uppercase tracking-wider">
                        {status.ad.brandName}
                      </span>
                    )}
                    <span className="shrink-0 font-bold opacity-70">
                      Page {status.booking.pageNumber} · {fmtPixels(status.booking.pixelCount)} px
                    </span>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2">
                    {status.ad.imageUrl && (
                      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/5 dark:bg-black/30">
                        <img
                          src={status.ad.imageUrl}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-contain"
                        />
                      </div>
                    )}

                    {status.ad.headline && (
                      <h3 className="font-headline text-xl font-black uppercase leading-tight">
                        {status.ad.headline}
                      </h3>
                    )}

                    {status.ad.description && (
                      <p className="font-editorial text-sm leading-snug opacity-90">
                        {status.ad.description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-current/20 px-3 py-1.5 font-data text-xs">
                    <a
                      href={status.ad.destinationUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="flex min-w-0 items-center gap-1 truncate font-bold underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{displayUrl(status.ad.destinationUrl)}</span>
                    </a>

                    {status.ad.ctaText && (
                      <span className="shrink-0 bg-[#191627] px-2 py-0.5 text-[10px] font-black uppercase text-white dark:bg-[#f2f0fb] dark:text-[#191627]">
                        {status.ad.ctaText}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* The receipt. */}
            <dl className="mx-auto grid max-w-lg grid-cols-2 gap-x-6 gap-y-2 rounded-xs border border-[#e0dcf0] bg-[#f0edfa] p-4 text-left font-data text-xs dark:border-[#2a2740] dark:bg-[#171526] sm:grid-cols-4">
              {(
                [
                  ['Page', `${status.booking.pageNumber}`],
                  ['Size', `${status.booking.width} × ${status.booking.height} px`],
                  ['Pixels', fmtPixels(status.booking.pixelCount)],
                  [
                    'Paid',
                    status.booking.amountPaid !== null
                      ? `${usd(status.booking.amountPaid)} ${status.booking.currency.toUpperCase()}`
                      : '—',
                  ],
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[10px] uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
                    {label}
                  </dt>
                  <dd className="font-bold text-[#191627] dark:text-white">{value}</dd>
                </div>
              ))}
            </dl>

            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
              <button
                onClick={() => onViewSpace(status.booking.pageNumber)}
                className="accent-button flex w-full cursor-pointer items-center justify-center gap-2 rounded-xs px-6 py-3 font-ui text-xs font-black uppercase tracking-wider text-white shadow-lg transition-all hover:scale-[1.02] sm:w-auto sm:flex-1"
              >
                <span>View my space</span>
                <ArrowRight className="h-4 w-4" />
              </button>

              {/* `#1da1f2` is X's blue, not a theme colour. A brand mark does
                  not change shade because the reader turned the lights off, so
                  this button is the same in both themes on purpose. */}
              <button
                onClick={handleShare}
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xs bg-[#1da1f2] px-5 py-3 font-ui text-xs font-black uppercase tracking-wider text-white shadow-md transition-all hover:bg-[#0c85d0] sm:w-auto"
              >
                <Share2 className="h-3.5 w-3.5" />
                <span>Share</span>
              </button>

              <button
                onClick={handleCopy}
                className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xs border border-[#191627] bg-white px-5 py-3 font-ui text-xs font-bold uppercase tracking-wider text-[#191627] transition-all hover:bg-zinc-100 dark:border-[#332f45] dark:bg-[#1b1826] dark:text-white dark:hover:bg-[#242138] sm:w-auto"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span>{copied ? 'Copied' : 'Copy link'}</span>
              </button>
            </div>
          </div>
        )}

        {/* ================================================================
            CONFIRMING
            ================================================================ */}
        {stillWaiting && !takingLong && (
          <div className="space-y-4 py-6">
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-[#7c3aed] dark:text-[#a78bfa]" />
            <h2 className="font-headline text-2xl font-black uppercase tracking-tight text-[#191627] dark:text-white sm:text-3xl">
              Confirming your payment
            </h2>
            <p className="mx-auto max-w-md font-editorial text-sm text-[#514c62] dark:text-[#a49eb6]">
              The payment provider is telling our server directly that the payment went through.
              We wait for that message rather than take your browser's word for it, which is what
              makes the claim real. This is usually a second or two.
            </p>
            <div className="mx-auto flex max-w-md items-start gap-2 rounded-xs border border-[#e0dcf0] bg-[#f0edfa] p-3 text-left font-data text-[11px] text-[#514c62] dark:border-[#2a2740] dark:bg-[#171526] dark:text-zinc-400">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>Your area is held while this completes. Please don't close this tab.</span>
            </div>
          </div>
        )}

        {/* ================================================================
            STILL WAITING, LONGER THAN EXPECTED
            ================================================================ */}
        {takingLong && (
          <div className="space-y-4 py-4">
            <AlertCircle className="mx-auto h-10 w-10 text-amber-600 dark:text-amber-400" />
            <h2 className="font-headline text-2xl font-black uppercase tracking-tight text-[#191627] dark:text-white">
              Still confirming
            </h2>
            <p className="mx-auto max-w-md font-editorial text-sm text-[#514c62] dark:text-[#a49eb6]">
              Your payment has not been confirmed to our server yet. If you completed the
              payment, the confirmation will still arrive and your space will appear — nothing is
              lost by leaving this page. If you did not complete it, nothing has been charged and
              the area returns to the paper shortly.
            </p>
            <div className="flex flex-col items-center justify-center gap-3 pt-2 sm:flex-row">
              <button
                onClick={() => setAttempts(0)}
                className="w-full cursor-pointer rounded-xs bg-[#191627] px-6 py-3 font-ui text-xs font-black uppercase tracking-wider text-white transition-all hover:opacity-90 dark:bg-[#f2f0fb] dark:text-[#191627] sm:w-auto"
              >
                Check again
              </button>
              <button
                onClick={onDismiss}
                className="w-full cursor-pointer font-data text-xs text-zinc-500 underline hover:text-black dark:hover:text-white sm:w-auto"
              >
                Back to the paper
              </button>
            </div>
          </div>
        )}

        {/* ================================================================
            CANCELLED OR NOT FOUND
            ================================================================ */}
        {(cancelled || error) && (
          <div className="space-y-4 py-4">
            <AlertCircle className="mx-auto h-10 w-10 text-[#7c3aed] dark:text-[#a78bfa]" />
            <h2 className="font-headline text-2xl font-black uppercase tracking-tight text-[#191627] dark:text-white">
              {cancelled ? 'Checkout cancelled' : 'Checkout not found'}
            </h2>
            <p className="mx-auto max-w-md font-editorial text-sm text-[#514c62] dark:text-[#a49eb6]">
              {error ??
                'Nothing was charged, and the space has gone back on the page for anyone to claim.'}
            </p>
            <button
              onClick={onDismiss}
              className="accent-button mt-2 w-full cursor-pointer rounded-xs px-6 py-3 font-ui text-xs font-black uppercase tracking-wider text-white shadow-lg transition-all sm:w-auto"
            >
              Back to the paper
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
