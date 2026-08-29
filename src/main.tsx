import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App.tsx';
import { ThemeProvider } from './context/ThemeContext.tsx';
import { LegalPage, type LegalPageKind } from './components/LegalPage.tsx';
import './index.css';

function legalPageForPath(pathname: string): LegalPageKind | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/terms') return 'terms';
  if (path === '/privacy') return 'privacy';
  if (path === '/refunds') return 'refunds';
  return null;
}

function Root() {
  const legalPage = legalPageForPath(window.location.pathname);
  return legalPage ? <LegalPage kind={legalPage} /> : <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </React.StrictMode>
);
