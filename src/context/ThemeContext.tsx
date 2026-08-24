/**
 * THEME
 * =====
 *
 * Three preferences — light, dark, or follow the operating system — persisted in
 * localStorage and applied as a `dark` class on <html>, which is what the
 * `@variant dark (&:where(.dark, .dark *))` rule in index.css keys off.
 *
 * The storage key and the class name are also read by the small inline script in
 * index.html, which runs before first paint so a dark-mode reader never gets a
 * flash of light newsprint. If you rename either one, rename it there too.
 */

import React, { createContext, useContext, useState, useEffect } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextType {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
}

/** Shared with the pre-paint script in index.html. Keep both in step. */
const THEME_STORAGE_KEY = 'the_internet_times_theme';

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY) as ThemePreference | null;
      if (saved === 'light' || saved === 'dark' || saved === 'system') {
        return saved;
      }
    } catch {
      // fallback
    }
    return 'system';
  });

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });

  // Listen to OS system theme changes
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light');
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  // Apply 'dark' class to html element and persist preference
  useEffect(() => {
    const root = document.documentElement;
    if (resolvedTheme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }

    // Tells the browser to render its own furniture — form controls, scrollbars,
    // the canvas behind a rubber-band scroll — to match. Without it a dark page
    // gets white scrollbars and white-flashing overscroll.
    root.style.colorScheme = resolvedTheme;

    // The two <meta name="theme-color"> tags in index.html are keyed to
    // prefers-color-scheme, which is the operating system's opinion, not the
    // reader's. Someone reading in light mode on a dark-mode phone would get a
    // black address bar above a cream page. Overriding them here keeps the
    // browser's own chrome in step with the choice actually made.
    const bar = resolvedTheme === 'dark' ? '#0b0a14' : '#f2effb';
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((tag) => {
        tag.removeAttribute('media');
        tag.setAttribute('content', bar);
      });

    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Private browsing or a full quota. A theme that does not persist is a
      // small loss; a crash on boot is not.
    }
  }, [theme, resolvedTheme]);

  const setTheme = (newTheme: ThemePreference) => {
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
