/**
 * A FULLY-PACKED FRONT PAGE, INVENTED ON THE CLIENT
 * =================================================
 *
 * The "Demo" button in the masthead fills the front page with realistic
 * advertisements, so the paper can be previewed exactly as it looks once people
 * have bought space on it. Only the cover is populated — one page is enough to
 * show what a real page of the paper reads like — and turning demo mode on brings
 * the reader to it.
 *
 * None of this ever touches the server. It is built here, held in memory, and
 * shown only while demo mode is on; the moment it is switched off, the genuine
 * server state is back. Nothing here is a booking, and no money is involved.
 *
 * The point of the demo is fidelity: every advertisement below is drawn by the
 * very same `NewspaperPage`/`AdBlock` code path a paid one is, at real logical
 * pixel coordinates, so a demo ad of a given size and position looks precisely
 * like a real booking of that size and position would. The images are inline
 * SVGs — they render with no network request and belong to no one.
 *
 * Coordinates are logical newspaper pixels on a 1000 × 1400 page, the same space
 * everything else in the app speaks. The rectangles sit below the cover's
 * masthead and are laid out so that no two ads overlap.
 */

import type { PricingConfig } from '../../shared/pricing-config.ts';
import type { NewspaperState, PlacedAd } from '../types.ts';

/** The one page the demo fills. */
export const DEMO_PAGE = 1;

/**
 * A small, self-contained "hero image": a diagonal gradient with a single glyph.
 * Returned as a data URI so it needs no network and can never 404 in a preview.
 */
function demoImage(from: string, to: string, glyph: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 200'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/>` +
    `</linearGradient></defs>` +
    `<rect width='320' height='200' fill='url(#g)'/>` +
    `<text x='160' y='134' font-family='Georgia, serif' font-size='104' font-weight='bold' ` +
    `fill='rgba(255,255,255,0.9)' text-anchor='middle'>${glyph}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Everything about a demo ad except the machinery filled in by `buildDemoPaper`. */
interface DemoSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  brandName: string;
  headline: string;
  description: string;
  ctaText: string;
  slug: string;
  /** [gradient start, gradient end, single-letter glyph] for the hero image. */
  image: [string, string, string];
}

/**
 * The demo cast, all on the cover. Sizes are chosen to exercise every rung of
 * `AdBlock`'s layout ladder — a wide hero with image, description and call to
 * action; a small logo-only mark that carries no text at all; two medium cards;
 * and a slim banner too short for an image — so the preview shows the whole range
 * of what a real page can hold, the logo-only shape included. Everything sits
 * below the masthead (which occupies roughly the top third of the cover).
 */
const SPECS: DemoSpec[] = [
  // ---- Wide hero, just under the masthead ----
  {
    x: 100, y: 420, width: 620, height: 300,
    brandName: 'Northwind Coffee',
    headline: 'Roasted the morning it ships',
    description:
      'Single-origin beans, roasted to order and at your door within 48 hours. No warehouse, no staleness — just coffee that tastes like the day it was made.',
    ctaText: 'Shop beans',
    slug: 'northwind',
    image: ['#f59e0b', '#b45309', 'N'],
  },
  // ---- Small logo-only mark, top-right beside the hero ----
  // No headline, description or button: on the page this renders as just the
  // linked logo, and at 150 × 150 it is well under the 260 × 200 an ordinary ad
  // needs before it shows an image — so it also exercises the logo-only bypass of
  // that size gate. A blank headline is what marks an ad "logo-only" everywhere.
  {
    x: 750, y: 420, width: 150, height: 150,
    brandName: 'Pixel Labs',
    headline: '',
    description: '',
    ctaText: '',
    slug: 'pixel-labs',
    image: ['#2563eb', '#7c3aed', 'P'],
  },
  // ---- Two medium cards, side by side ----
  {
    x: 100, y: 760, width: 390, height: 330,
    brandName: 'Atlas Boots',
    headline: 'Built to be resoled, not replaced',
    description:
      'Goodyear-welted leather boots made in small batches. Buy one pair, wear it for a decade, and send it back for a fresh sole when the road finally wins.',
    ctaText: 'See the range',
    slug: 'atlas-boots',
    image: ['#0f766e', '#065f46', 'A'],
  },
  {
    x: 510, y: 760, width: 390, height: 330,
    brandName: 'Sunday Roast',
    headline: 'Dinner, sorted',
    description:
      'Recipe boxes with everything measured out. Cook a proper meal in thirty minutes flat, then do it again tomorrow with something new.',
    ctaText: 'Start cooking',
    slug: 'sunday-roast',
    image: ['#dc2626', '#991b1b', 'S'],
  },
  // ---- Slim banner along the bottom ----
  {
    x: 100, y: 1130, width: 800, height: 170,
    brandName: 'The Margin',
    headline: 'A weekly letter for people who build',
    description:
      'Essays on design, software, and the craft of doing careful work. Free, every Sunday morning.',
    ctaText: 'Subscribe',
    slug: 'the-margin',
    image: ['#7c3aed', '#db2777', 'M'],
  },
];

/**
 * Turn the specs into a complete `NewspaperState`: priced-looking ads on the
 * cover, matching occupied areas, and stats derived from the ads themselves so
 * the sidebar's "claimed" figures add up. `totalPixels` is taken from the live
 * config, so the demo stays honest about how big the paper actually is.
 */
export function buildDemoPaper(config: PricingConfig): NewspaperState {
  const ads: PlacedAd[] = SPECS.map((spec, index) => ({
    bookingId: `demo-${spec.slug}`,
    pageNumber: DEMO_PAGE,
    x: spec.x,
    y: spec.y,
    width: spec.width,
    height: spec.height,
    pixelCount: spec.width * spec.height,
    brandName: spec.brandName,
    headline: spec.headline,
    description: spec.description,
    destinationUrl: `https://example.com/${spec.slug}`,
    imageUrl: demoImage(spec.image[0], spec.image[1], spec.image[2]),
    ctaText: spec.ctaText,
    // A fixed, believable claim date — spread across recent months by index so
    // the ads don't all look bought on the same day. No live clock is read.
    claimedAt: `2026-0${1 + (index % 8)}-${String(3 + (index % 25)).padStart(2, '0')}T09:15:00.000Z`,
  }));

  const claimedPixels = ads.reduce((sum, ad) => sum + ad.pixelCount, 0);
  const totalPixels = config.pageWidth * config.pageHeight * config.totalPages;

  return {
    ads,
    occupied: ads.map((ad) => ({
      x: ad.x,
      y: ad.y,
      width: ad.width,
      height: ad.height,
      pageNumber: ad.pageNumber,
      status: 'paid' as const,
    })),
    stats: {
      paidBookings: ads.length,
      claimedPixels,
      totalPixels,
    },
  };
}
