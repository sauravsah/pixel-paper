import { useId } from 'react';

/**
 * PIXEL PRESS brand mark.
 *
 * The glyph is a small pixel canvas — a 4×4 grid of cells. Most sit faint and
 * "unclaimed"; a diagonal stroke of cells is lit in the brand gradient (the
 * headline sweep), and two opposite corners glow as spot pixels in cyan and
 * amber. Read together it says: a page (the grid) made of pixels (digital),
 * with colourful claimed space running across it (ownership + creativity).
 *
 * It is deliberately abstract — no letters — so it works as a favicon and app
 * icon and stays legible down to 16px, where only the gradient diagonal and
 * the two spot pixels need to survive.
 */

const CELL = 5;
const GAP = 1.4;
const STEP = CELL + GAP;

// Grid cells (col, row) lit with the continuous brand gradient — a bold
// diagonal running top-left to bottom-right, the "claimed headline".
const STROKE_CELLS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [2, 1],
  [2, 2],
  [2, 3],
  [3, 3],
];

// Two playful spot pixels in the opposite corners.
const SPOT_CELLS: Array<{ cell: [number, number]; color: string }> = [
  { cell: [3, 0], color: '#06b6d4' }, // cyan
  { cell: [0, 3], color: '#fbbf24' }, // amber
];

function isStroke(col: number, row: number): boolean {
  return STROKE_CELLS.some(([c, r]) => c === col && r === row);
}

function spotAt(col: number, row: number): string | null {
  const hit = SPOT_CELLS.find(({ cell: [c, r] }) => c === col && r === row);
  return hit ? hit.color : null;
}

interface PixelMarkProps {
  /** Rendered width/height in px. */
  size?: number;
  className?: string;
  /** Brighten the gradient for dark grounds. */
  bright?: boolean;
  'aria-hidden'?: boolean;
}

export function PixelMark({ size = 28, className, bright = false, ...rest }: PixelMarkProps) {
  const gid = useId().replace(/:/g, '');
  const gradientId = `pp-mark-grad-${gid}`;
  const total = 4 * STEP - GAP; // exact extent of the grid

  const stops = bright
    ? [
        { offset: '0%', color: '#a78bfa' },
        { offset: '55%', color: '#f472b6' },
        { offset: '100%', color: '#fda4af' },
      ]
    : [
        { offset: '0%', color: '#7c3aed' },
        { offset: '55%', color: '#db2777' },
        { offset: '100%', color: '#fb7185' },
      ];

  const faint = bright ? 'rgba(167,139,250,0.22)' : 'rgba(124,58,237,0.16)';

  const cells = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const x = col * STEP;
      const y = row * STEP;
      const spot = spotAt(col, row);
      let fill: string;
      if (isStroke(col, row)) {
        fill = `url(#${gradientId})`;
      } else if (spot) {
        fill = spot;
      } else {
        fill = faint;
      }
      cells.push(
        <rect
          key={`${col}-${row}`}
          x={x}
          y={y}
          width={CELL}
          height={CELL}
          rx={1.1}
          fill={fill}
        />,
      );
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={rest['aria-hidden'] ? undefined : 'Pixel Press'}
      aria-hidden={rest['aria-hidden']}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2={total} y2={total} gradientUnits="userSpaceOnUse">
          {stops.map((s) => (
            <stop key={s.offset} offset={s.offset} stopColor={s.color} />
          ))}
        </linearGradient>
      </defs>
      {cells}
    </svg>
  );
}

interface WordmarkProps {
  className?: string;
  /** Tailwind text-size classes, e.g. "text-xl". */
  size?: string;
}

/**
 * "PIXEL PRESS" wordmark. "PIXEL" in ink, "PRESS" in the brand gradient, so the
 * name carries the same colour story as the mark without shouting.
 */
export function PixelWordmark({ className = '', size = 'text-lg' }: WordmarkProps) {
  return (
    <span
      className={`font-headline font-bold uppercase leading-none tracking-tight ${size} ${className}`}
    >
      <span className="text-[#191627] dark:text-[#f2f0fb]">Pixel</span>
      <span className="pp-word"> Press</span>
    </span>
  );
}

interface LogoProps {
  /** Icon size in px. */
  iconSize?: number;
  /** Wordmark text-size class. */
  wordmarkSize?: string;
  /** Hide the wordmark, showing just the mark. */
  iconOnly?: boolean;
  bright?: boolean;
  className?: string;
}

/** The mark and wordmark locked up together — the default header/sidebar logo. */
export function PixelPaperLogo({
  iconSize = 30,
  wordmarkSize = 'text-lg',
  iconOnly = false,
  bright = false,
  className = '',
}: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <PixelMark size={iconSize} bright={bright} aria-hidden={!iconOnly} />
      {!iconOnly && <PixelWordmark size={wordmarkSize} />}
    </span>
  );
}
