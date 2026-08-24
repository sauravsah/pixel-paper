import React from 'react';
import { useTheme, ThemePreference } from '../context/ThemeContext';
import { Sun, Moon, Monitor } from 'lucide-react';

export const ThemeSwitcher: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { theme, setTheme } = useTheme();

  const options: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
    { value: 'light', label: 'Light', icon: <Sun className="w-3.5 h-3.5" /> },
    { value: 'dark', label: 'Dark', icon: <Moon className="w-3.5 h-3.5" /> },
    { value: 'system', label: 'Auto', icon: <Monitor className="w-3.5 h-3.5" /> },
  ];

  return (
    <div 
      className="inline-flex items-center p-0.5 rounded-xs bg-[#e7e2f3] dark:bg-[#171526] border border-[#d6cfec] dark:border-[#2a2740] text-xs font-data transition-colors shadow-xs"
      role="group"
      aria-label="Theme selector"
    >
      {options.map((opt) => {
        const isActive = theme === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => setTheme(opt.value)}
            className={`flex items-center gap-1 px-2 py-1 rounded-xs transition-all cursor-pointer font-bold ${
              isActive
                ? 'bg-white dark:bg-[#26233c] text-[#191627] dark:text-white shadow-xs scale-100'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-[#191627] dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'
            }`}
            title={`Switch to ${opt.label} Mode`}
            aria-pressed={isActive}
          >
            {opt.icon}
            {!compact && <span className="text-[11px] hidden sm:inline">{opt.label}</span>}
          </button>
        );
      })}
    </div>
  );
};
