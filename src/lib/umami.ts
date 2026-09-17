const DEFAULT_SCRIPT_URL = 'https://cloud.umami.is/script.js';
const PRODUCTION_DOMAINS = 'pixelpaper.lol,www.pixelpaper.lol';

/** Install Umami only when its public Website ID is configured at build time. */
export function installUmami(): void {
  if (typeof document === 'undefined') return;

  const websiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID?.trim() ?? '';
  if (!websiteId) return;

  const scriptUrl = import.meta.env.VITE_UMAMI_SCRIPT_URL?.trim() || DEFAULT_SCRIPT_URL;
  let resolvedUrl: URL;
  try {
    resolvedUrl = new URL(scriptUrl, window.location.origin);
  } catch {
    return;
  }
  if (resolvedUrl.protocol !== 'https:') return;

  const alreadyInstalled = Array.from(
    document.querySelectorAll('script[data-website-id]')
  ).some((script) => script.getAttribute('data-website-id') === websiteId);
  if (alreadyInstalled) return;

  const script = document.createElement('script');
  script.defer = true;
  script.src = resolvedUrl.toString();
  script.dataset.websiteId = websiteId;
  script.dataset.domains = PRODUCTION_DOMAINS;
  document.head.appendChild(script);
}
