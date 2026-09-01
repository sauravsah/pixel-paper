/**
 * ABOUT
 * =====
 *
 * The explanation, kept out of the newspaper.
 *
 * This exists so the paper itself does not have to carry its own instructions.
 * Pages of Pixel Units that people paid for are not the place for a sales pitch, so
 * everything that needs saying about how the thing works is said here instead, and
 * the paper is left to be a paper.
 *
 * Every figure comes from the pricing config the server sent. There is no rate
 * typed into this file, because a marketing page quoting a price the checkout does
 * not honour is worse than no marketing page.
 */

import React from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';

import type { PricingConfig } from '../../shared/pricing-config.ts';
import { rate as fmtRate } from '../lib/selection.ts';
import { PixelMark } from './PixelMark.tsx';

interface AboutViewProps {
  config: PricingConfig;
  onStartBuying: () => void;
  onBack: () => void;
}

export const AboutView: React.FC<AboutViewProps> = ({ config, onStartBuying, onBack }) => {
  const steps: [string, string, string][] = [
    [
      '01',
      'Pick your place',
          `Open the paper and drag out any rectangle on any of the ${config.totalPages} pages. The price updates as you drag, and it is worked out from page tier and Pixel Unit count.`,
    ],
    [
      '02',
      'Write what it says',
      'A name, a headline, and the address it should link to. A description, an image and a button label are yours to add if you want them.',
    ],
    [
      '03',
      'Pay once',
      `From ${fmtRate(config.baseRate)} a Pixel Unit. There is no subscription, no renewal, and no invoice next month.`,
    ],
    [
      '04',
      'Stay there',
      'Those pixels stop being for sale. Your space is part of the paper from then on, for whoever opens it next.',
    ],
  ];

  return (
    <div className="my-4 w-full max-w-4xl space-y-8 rounded-xs border-4 border-[#191627] bg-[#fdfcff] p-6 text-[#191627] shadow-2xl transition-colors duration-200 dark:border-[#332f45] dark:bg-[#16131f] dark:text-[#f2f0fb] sm:p-10">
      {/* ---- Masthead ---- */}
      <header className="space-y-2 border-b-4 border-[#191627] pb-6 text-center dark:border-[#332f45]">
        <PixelMark size={52} className="mx-auto pp-glow rounded-lg" aria-hidden />
        <div className="font-data text-xs font-bold uppercase tracking-widest text-[#7c3aed] dark:text-[#a78bfa]">
          How this works
        </div>
        <h1 className="font-masthead text-3xl font-black uppercase leading-none tracking-tight text-[#191627] dark:text-white sm:text-5xl">
          Pixel <span className="pp-word">Press</span>
        </h1>
        <p className="mx-auto max-w-xl font-editorial text-base italic text-[#514c62] dark:text-[#b4aec4] sm:text-lg">
          The permanent digital newspaper.
        </p>
      </header>

      {/* ---- The whole idea, in one banner ----
           Dark in both themes on purpose. This is the one block on the page
           that has to stop the eye, and in light mode a dark panel does that;
           it is a printed advertisement in the middle of newsprint, not a
           surface that forgot its `dark:` variant. So `border-[#2a2742]` and
           `text-[#fda4af]` below have no light-mode counterparts by design. */}
      <section className="space-y-4 rounded-xs border border-[#2a2742] bg-[#191627] p-6 text-white shadow-xl dark:bg-[#1b1827] sm:p-8">
        <div className="flex items-center gap-2 font-data text-xs font-bold uppercase tracking-wider text-[#fda4af]">
          <Sparkles className="h-4 w-4" />
          <span>Buy it once. It stays.</span>
        </div>
        <h2 className="font-headline text-2xl font-black uppercase leading-tight sm:text-3xl">
          Claim a piece of Pixel Paper
        </h2>
        <p className="font-editorial text-sm leading-relaxed text-zinc-300 sm:text-base">
          Choose any available space. Add your link. Pay once. Stay here permanently. There are{' '}
          {config.totalPages} launch pages, starting with the front page and continuing through
          four spreads. Pixel Units are logical newspaper inventory, so ownership does not change
          when the reader scales on desktop, tablet or mobile.
        </p>
      </section>

      {/* ---- Four steps ---- */}
      <section className="space-y-4">
        <h3 className="border-b-2 border-[#191627] pb-2 font-headline text-xl font-black uppercase tracking-tight dark:border-[#332f45]">
          Four steps
        </h3>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {steps.map(([number, title, body]) => (
            <div
              key={number}
              className="space-y-2 rounded-xs border-2 border-[#191627] bg-white p-4 shadow-xs dark:border-[#332f45] dark:bg-[#1b1826]"
            >
              <div className="flex items-center gap-2 font-data text-sm font-bold text-[#191627] dark:text-white">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#7c3aed] font-data text-[10px] font-black text-white dark:bg-[#a78bfa]">
                  {number}
                </span>
                <span className="uppercase tracking-wider">{title}</span>
              </div>
              <p className="font-editorial text-sm leading-relaxed text-[#514c62] dark:text-[#b4aec4]">
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- What the price depends on ---- */}
      <section className="space-y-3 rounded-xs border-2 border-[#191627] bg-[#f0edfa] p-6 dark:border-[#332f45] dark:bg-[#1b1826]">
        <h4 className="font-headline text-base font-black uppercase text-[#191627] dark:text-white">
          What changes the price
        </h4>
        <p className="font-editorial text-sm leading-relaxed text-[#332f45] dark:text-[#b4aec4]">
          Which page or spread you choose, and how many Pixel Units you claim. Earlier pages cost
          more than later pages. Exact visual position does not change the V1 price.
        </p>
        <p className="font-editorial text-sm leading-relaxed text-[#332f45] dark:text-[#b4aec4]">
          What you are advertising makes no difference at all. There is no rate card for startups
          and another for everyone else, and no page reserved for a particular kind of buyer. A
          rectangle costs what the rectangle costs.
        </p>
      </section>

      {/* ---- What you can put there ---- */}
      <section className="space-y-3 rounded-xs border-2 border-[#191627] bg-white p-6 dark:border-[#332f45] dark:bg-[#1b1826]">
        <h4 className="font-headline text-base font-black uppercase text-[#191627] dark:text-white">
          What can go in your space
        </h4>
        <p className="font-editorial text-sm leading-relaxed text-[#332f45] dark:text-[#b4aec4]">
          Anything legitimate with a link behind it: a site, an app, a video, a profile, a project,
          a newsletter, a portfolio, a shop, or a message you want to leave somewhere it will not be
          deleted.
        </p>
      </section>

      {/* ---- Nothing here is a placeholder ---- */}
      <section className="rounded-xs border border-dashed border-[#dcd6ec] bg-[#faf8ff] p-5 dark:border-[#2a2740] dark:bg-[#141221]">
        <p className="font-editorial text-sm leading-relaxed text-[#514c62] dark:text-[#a49eb6]">
          Every published space is backed by database inventory. Preview placements are only examples
          for review mode; production placements should appear after verified payment and moderation.
        </p>
      </section>

      {/* ---- Footer ---- */}
      <footer className="flex flex-col items-center justify-between gap-4 border-t-2 border-[#191627] pt-4 dark:border-[#332f45] sm:flex-row">
        <button
          type="button"
          onClick={onBack}
          className="w-full cursor-pointer rounded-xs border border-[#191627] bg-[#f0edfa] px-6 py-3 font-ui text-xs font-bold uppercase text-[#191627] transition-colors hover:bg-[#eae5f6] dark:border-[#332f45] dark:bg-[#1b1826] dark:text-white dark:hover:bg-[#242138] sm:w-auto"
        >
          Back to the paper
        </button>

        <button
          type="button"
          onClick={onStartBuying}
          className="accent-button flex w-full cursor-pointer items-center justify-center gap-2 rounded-xs px-8 py-3 font-ui text-xs font-black uppercase tracking-wider text-white shadow-xl transition-all sm:w-auto"
        >
          <span>Choose a space</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      </footer>
    </div>
  );
};
