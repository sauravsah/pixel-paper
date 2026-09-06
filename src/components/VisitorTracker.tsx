import React from 'react';
import { Activity } from 'lucide-react';

import type { VisitorStats } from '../types.ts';

interface VisitorTrackerProps {
  stats: VisitorStats | null;
  compact?: boolean;
}

const displayCount = (value: number | undefined): string =>
  value === undefined ? '—' : value.toLocaleString();

export const VisitorTracker: React.FC<VisitorTrackerProps> = ({ stats, compact = false }) => {
  if (compact) {
    return (
      <div
        aria-label="Reader activity"
        title="Live readers and visits in the last 24 hours"
        className="flex shrink-0 items-center gap-2 rounded-xs border border-[#dcd6ec] bg-white px-2.5 py-1.5 font-data shadow-sm dark:border-[#2a2740] dark:bg-[#171526]"
      >
        <span className="flex h-3 items-end gap-0.5" aria-hidden="true">
          <span className="h-1.5 w-1 animate-pulse rounded-full bg-[#7c3aed]" />
          <span className="h-2.5 w-1 animate-pulse rounded-full bg-[#ec4899] [animation-delay:150ms]" />
          <span className="h-2 w-1 animate-pulse rounded-full bg-[#06b6d4] [animation-delay:300ms]" />
        </span>
        <span className="flex items-baseline gap-1 text-[10px] font-black uppercase tracking-wider text-[#191627] dark:text-zinc-100">
          <span className="text-[#7c3aed] dark:text-[#a78bfa]">{displayCount(stats?.liveVisitors)}</span>
          <span className="text-[8px] text-[#6f6a80] dark:text-zinc-500">live</span>
        </span>
        <span className="h-3 w-px bg-[#dcd6ec] dark:bg-[#2a2740]" aria-hidden="true" />
        <span className="flex items-baseline gap-1 text-[10px] font-black uppercase tracking-wider text-[#191627] dark:text-zinc-100">
          <span className="text-[#ec4899] dark:text-[#f472b6]">{displayCount(stats?.visitors24h)}</span>
          <span className="text-[8px] text-[#6f6a80] dark:text-zinc-500">24h</span>
        </span>
      </div>
    );
  }

  return (
    <section
      aria-label="Reader activity"
      className="space-y-2 border-b border-[#e0dcf0] pb-4 dark:border-[#2a2740]"
    >
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 font-data text-[9px] font-black uppercase tracking-[0.2em] text-[#6f6a80] dark:text-zinc-500">
        <Activity className="h-3.5 w-3.5 text-[#7c3aed] dark:text-[#a78bfa]" />
        Readers
      </h2>
      <span className="flex items-center gap-1 font-data text-[9px] font-bold uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
        Live count
      </span>
    </div>

    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 font-data">
      <div>
        <strong className="text-lg font-black text-[#191627] dark:text-zinc-100">
          {displayCount(stats?.liveVisitors)}
        </strong>
        <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
          live now
        </span>
      </div>
      <div>
        <strong className="text-lg font-black text-[#191627] dark:text-zinc-100">
          {displayCount(stats?.visitors24h)}
        </strong>
        <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
          in 24h
        </span>
      </div>
    </div>

    <p className="font-editorial text-[10px] leading-snug text-[#6f6a80] dark:text-zinc-500">
      Live means active in the last two minutes. Counts are anonymous visitor sessions.
    </p>
    </section>
  );
};
