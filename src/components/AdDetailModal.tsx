/**
 * AN AD, OPENED
 * =============
 *
 * A reader's closer look at somebody's space: what it says, where it goes, and
 * how much of the page it occupies.
 *
 * What it does not show is what the buyer paid. That figure exists in the
 * database and it is deliberately absent from `/api/newspaper` and
 * `/api/spaces/:id`, so it never reaches this component to be leaked. What
 * someone paid for their pixels is between them and the payment provider; the
 * going rate for a position is public, and that is a different thing.
 */

import React from 'react';
import { ExternalLink, Sparkles, Tag, X } from 'lucide-react';

import type { PricingConfig } from '../../shared/pricing-config.ts';
import type { PlacedAd } from '../types.ts';
import { displayUrl, pixels as fmtPixels } from '../lib/selection.ts';

interface AdDetailModalProps {
  ad: PlacedAd | null;
  config: PricingConfig;
  onClose: () => void;
  onStartBuying: () => void;
}

export const AdDetailModal: React.FC<AdDetailModalProps> = ({
  ad,
  config,
  onClose,
  onStartBuying,
}) => {
  if (!ad) return null;

  // A logo-only ad carries no headline, and maybe no brand. Fall back through the
  // brand and then the destination so the dialog's label is never empty.
  const label = ad.headline
    ? ad.brandName
      ? `${ad.brandName} — ${ad.headline}`
      : ad.headline
    : ad.brandName || displayUrl(ad.destinationUrl);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div className="relative my-8 w-full max-w-lg rounded-xs border-4 border-[#191627] bg-[#fdfcff] p-6 text-[#191627] shadow-2xl transition-colors duration-200 dark:border-[#332f45] dark:bg-[#16131f] dark:text-[#f2f0fb]">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 cursor-pointer rounded-xs p-1.5 text-[#191627] hover:bg-[#e6e1f2] dark:text-zinc-300 dark:hover:bg-[#221f36]"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>

        <header className="mb-4 border-b-2 border-[#191627] pb-3 pr-10 dark:border-[#332f45]">
          <div className="mb-1 flex items-center gap-1 font-data text-xs font-bold uppercase tracking-wider text-[#7c3aed] dark:text-[#a78bfa]">
            <Tag className="h-3.5 w-3.5" />
            <span>
              Page {ad.pageNumber} of {config.totalPages}
            </span>
          </div>
          {ad.brandName && (
            <h3 className="font-headline text-2xl font-black uppercase tracking-tight text-[#191627] dark:text-white">
              {ad.brandName}
            </h3>
          )}
          <p className="font-data text-xs text-[#514c62] dark:text-[#a49eb6]">
            {ad.width} × {ad.height} Pixel Units · {fmtPixels(ad.pixelCount)} units · claimed
            permanently
          </p>
        </header>

        <div className="mb-4 space-y-2 rounded-xs border-2 border-[#191627] bg-white p-4 dark:border-[#332f45] dark:bg-[#1b1826]">
          {ad.imageUrl && (
            <div className="mb-3 flex max-h-48 items-center justify-center overflow-hidden border border-[#e0dcf0] bg-black/5 dark:border-[#2a2740] dark:bg-black/30">
              <img
                src={ad.imageUrl}
                alt=""
                referrerPolicy="no-referrer"
                className="max-h-48 w-full object-contain"
              />
            </div>
          )}

          {ad.headline && (
            <div className="font-headline text-lg font-black uppercase leading-tight text-[#191627] dark:text-white">
              {ad.headline}
            </div>
          )}

          {ad.description && (
            <p className="font-editorial text-sm leading-relaxed text-[#332f45] dark:text-zinc-300">
              {ad.description}
            </p>
          )}

          <div className="pt-2">
            <a
              href={ad.destinationUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1.5 font-data text-xs font-bold text-[#2563eb] underline hover:text-[#1d4ed8] dark:text-[#60a5fa] dark:hover:text-[#93c5fd]"
            >
              <span>Visit {displayUrl(ad.destinationUrl)}</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {ad.ctaText && (
              <span className="ml-2 bg-[#191627] px-2 py-0.5 font-data text-[10px] font-black uppercase text-white dark:bg-[#f2f0fb] dark:text-[#191627]">
                {ad.ctaText}
              </span>
            )}
          </div>
        </div>

        <p className="mb-5 rounded-xs border border-[#e0dcf0] bg-[#f0edfa] p-3.5 font-editorial text-xs leading-relaxed text-[#514c62] dark:border-[#2a2740] dark:bg-[#1a1826] dark:text-zinc-400">
          Somebody chose this exact rectangle, paid for it once, and it is theirs. Every space on
          these {config.totalPages} pages works the same way — no renewals, no expiry, and the
          price depends only on which page and where on it, never on what is being advertised.
        </p>

        <div className="flex items-center justify-between gap-3 border-t border-[#e0dcf0] pt-3 dark:border-[#2a2740]">
          <button
            onClick={onClose}
            className="cursor-pointer font-data text-xs text-zinc-500 underline hover:text-black dark:hover:text-white"
          >
            Close
          </button>

          <button
            onClick={() => {
              onClose();
              onStartBuying();
            }}
            className="accent-button flex cursor-pointer items-center gap-1.5 rounded-xs px-4 py-2 font-ui text-xs font-black uppercase text-white shadow-md transition-all"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Claim your own space</span>
          </button>
        </div>
      </div>
    </div>
  );
};
