import React from 'react';
import { BookOpen, Maximize2, MousePointerClick, PanelLeft, PanelRight } from 'lucide-react';

interface PaperToolbarProps {
  isSelectMode: boolean;
  isPagesOpen: boolean;
  isDetailsOpen: boolean;
  onModeChange: (selectMode: boolean) => void;
  onTogglePages: () => void;
  onToggleDetails: () => void;
  onToggleImmersive: () => void;
  className?: string;
}

/** Compact reader controls; navigation and business actions stay in their owners. */
export const PaperToolbar: React.FC<PaperToolbarProps> = ({
  isSelectMode,
  isPagesOpen,
  isDetailsOpen,
  onModeChange,
  onTogglePages,
  onToggleDetails,
  onToggleImmersive,
  className,
}) => (
  <div className={`flex min-w-0 items-center justify-between gap-2 ${className ?? ''}`}>
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onTogglePages}
        aria-pressed={isPagesOpen}
        aria-label={isPagesOpen ? 'Close pages menu' : 'Open pages menu'}
        title={isPagesOpen ? 'Close pages menu' : 'Pages and menu'}
        className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-xs border px-2.5 text-[#514c62] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] dark:text-zinc-400 dark:focus-visible:ring-[#a78bfa] ${
          isPagesOpen
            ? 'accent-button border-transparent text-white'
            : 'border-[#dcd6ec] bg-white hover:border-[#7c3aed] hover:text-[#191627] dark:border-[#2a2740] dark:bg-[#171526] dark:hover:border-[#a78bfa] dark:hover:text-white'
        }`}
      >
        <PanelLeft className="h-4 w-4" />
        <span className="hidden font-data text-[10px] font-black uppercase tracking-wider sm:inline">
          Pages
        </span>
      </button>

      <div className="flex items-center gap-0.5 rounded-xs border border-[#dcd6ec] bg-[#ece8f8] p-0.5 dark:border-[#2a2740] dark:bg-[#171526]">
        <button
          type="button"
          onClick={() => onModeChange(false)}
          aria-pressed={!isSelectMode}
          className={`flex h-8 cursor-pointer items-center gap-1 rounded-xs px-2 font-data text-[10px] font-black uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] dark:focus-visible:ring-[#a78bfa] sm:px-2.5 ${
            !isSelectMode
              ? 'bg-[#191627] text-white shadow-sm dark:bg-[#f2f0fb] dark:text-[#191627]'
              : 'text-[#514c62] hover:text-[#191627] dark:text-zinc-400 dark:hover:text-white'
          }`}
        >
          <BookOpen className="h-3.5 w-3.5" />
          <span>Read</span>
        </button>
        <button
          type="button"
          onClick={() => onModeChange(true)}
          aria-pressed={isSelectMode}
          className={`flex h-8 cursor-pointer items-center gap-1 rounded-xs px-2 font-data text-[10px] font-black uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] dark:focus-visible:ring-[#a78bfa] sm:px-2.5 ${
            isSelectMode
              ? 'accent-button text-white shadow-sm'
              : 'text-[#514c62] hover:text-[#191627] dark:text-zinc-400 dark:hover:text-white'
          }`}
        >
          <MousePointerClick className="h-3.5 w-3.5" />
          <span>Buy</span>
        </button>
      </div>
    </div>

    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onToggleImmersive}
        aria-label="Expand newspaper"
        title="Expand newspaper"
        className="accent-button flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-xs border border-transparent px-2.5 font-data text-[10px] font-black uppercase tracking-wider text-white shadow-md transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0b0a14]"
      >
        <Maximize2 className="h-4 w-4" />
        <span className="hidden sm:inline">Expand newspaper</span>
      </button>

      <button
        type="button"
        onClick={onToggleDetails}
        aria-pressed={isDetailsOpen}
        aria-label="Open paper details"
        title="Paper details, price map, and help"
        className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-xs border px-2.5 font-data text-[10px] font-black uppercase tracking-wider shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed] dark:focus-visible:ring-[#a78bfa] ${
          isDetailsOpen
            ? 'accent-button border-transparent text-white'
            : 'border-[#dcd6ec] bg-white text-[#514c62] hover:border-[#7c3aed] hover:text-[#191627] dark:border-[#2a2740] dark:bg-[#171526] dark:text-zinc-400 dark:hover:border-[#a78bfa] dark:hover:text-white'
        }`}
      >
        <PanelRight className="h-4 w-4" />
        <span className="hidden sm:inline">Details</span>
      </button>
    </div>
  </div>
);
