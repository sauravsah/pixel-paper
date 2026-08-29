import { useEffect } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import { PixelMark, PixelWordmark } from './PixelMark.tsx';

export type LegalPageKind = 'terms' | 'privacy' | 'refunds';

interface LegalSection {
  heading: string;
  paragraphs: string[];
}

interface LegalDocument {
  kind: LegalPageKind;
  label: string;
  title: string;
  description: string;
  intro: string;
  sections: LegalSection[];
}

const DOCUMENTS: Record<LegalPageKind, LegalDocument> = {
  terms: {
    kind: 'terms',
    label: 'Terms of use',
    title: 'Terms of use',
    description: 'Plain-language terms for using Pixel Paper and purchasing a newspaper placement.',
    intro:
      'Pixel Paper is an independent, experimental digital project. These terms explain what the service is, what a purchase means, and the limits of what we can promise.',
    sections: [
      {
        heading: 'An evolving service',
        paragraphs: [
          'Pixel Paper is intended to be a lasting digital newspaper, but it is operated as an experimental service. We do not guarantee that the website, newspaper, pages, advertisements, or placements will remain available for any particular period.',
          'We may change, suspend, restrict, or discontinue any part of the service. This can happen because of technical failures, infrastructure or third-party failures, security incidents, operational or financial reasons, legal requirements, or circumstances beyond our reasonable control.',
          'If the service is discontinued, previously purchased placements may no longer remain publicly accessible. A purchase is not a guarantee of ongoing hosting, visibility, or access to a particular page.',
        ],
      },
      {
        heading: 'Purchases and placements',
        paragraphs: [
          'The checkout page shows the Pixel Unit area and price before you continue. A placement is created only after the payment provider confirms the payment to our server and any applicable review is complete.',
          'Pixel Paper may decline, hide, or remove content that is unlawful, misleading, abusive, infringing, unsafe, or otherwise inconsistent with the service. A moderation decision may be made before or after payment where necessary.',
          'You are responsible for having the right to submit your name, logo, text, images, and destination link. You give Pixel Paper permission to display that material as part of the placement while the service is available.',
        ],
      },
      {
        heading: 'Third-party services',
        paragraphs: [
          'Payments are handled on a hosted checkout provided by Dodo Payments. Their terms, privacy practices, payment decisions, and service availability may also apply to your transaction.',
        ],
      },
      {
        heading: 'Responsibility and limits',
        paragraphs: [
          'To the extent permitted by applicable law, Pixel Paper is not responsible for indirect, incidental, special, or consequential loss arising from use of the service or from a placement becoming unavailable. We do not exclude responsibility that the law does not allow us to exclude.',
          'Nothing in these terms removes or limits consumer, statutory, or other rights that cannot legally be excluded or limited.',
        ],
      },
      {
        heading: 'Contact',
        paragraphs: [
          'For questions about a purchase or placement, use the support contact provided with your order. Business contact details should be added here before launch if a separate support address is required.',
        ],
      },
    ],
  },
  privacy: {
    kind: 'privacy',
    label: 'Privacy policy',
    title: 'Privacy policy',
    description: 'How Pixel Paper handles information used to publish placements, process payments, and operate the newspaper.',
    intro:
      'This plain-language summary describes the information Pixel Paper may receive when you read the paper or submit a placement.',
    sections: [
      {
        heading: 'Information we receive',
        paragraphs: [
          'When you submit a placement, we may receive the brand name, headline, description, destination URL, logo or image, email address, selected area, and related order details. Dodo Payments handles card and payment-method details on its hosted checkout; Pixel Paper does not store card numbers or security codes.',
          'When people read the paper, we may receive limited technical information and privacy-conscious activity events such as page views, paper opens, and placement clicks. These events help us understand whether the newspaper is working and do not need to identify a reader by name.',
        ],
      },
      {
        heading: 'How we use information',
        paragraphs: [
          'We use information to publish and moderate placements, process orders, confirm payments, prevent abuse, answer support requests, keep the service secure, and improve the newspaper experience.',
        ],
      },
      {
        heading: 'Service providers',
        paragraphs: [
          'We may use infrastructure and service providers such as Supabase for application data and Dodo Payments for checkout and payment processing. Providers receive only the information needed for their role and may handle it under their own terms and privacy notices.',
        ],
      },
      {
        heading: 'Storage and choices',
        paragraphs: [
          'We keep information for as long as it is needed to operate the service, maintain transaction records, resolve disputes, meet legal obligations, and protect the platform. Retention periods can vary by the type of information.',
          'You may contact us to ask about information associated with your placement or order. Requests are handled subject to applicable law and reasonable verification. Add the appropriate business privacy contact details here before launch.',
        ],
      },
      {
        heading: 'Updates',
        paragraphs: [
          'This policy may be updated as Pixel Paper changes. The current version will be published on this page.',
        ],
      },
    ],
  },
  refunds: {
    kind: 'refunds',
    label: 'Refund policy',
    title: 'Refund policy',
    description: 'When a Pixel Paper placement purchase may be eligible for a refund.',
    intro:
      'We want the purchase and placement experience to be clear. This policy explains when to contact us about a refund and what we will review.',
    sections: [
      {
        heading: 'When to request a refund',
        paragraphs: [
          'You may request a refund if you were charged more than once for the same purchase, if a payment was taken but we could not deliver the purchased placement because of a failure on our side, or if a material service problem prevented the placement from being provided as described.',
          'Please include your order or booking reference and the payment receipt when contacting us. We will review the request and, when approved, send the refund to the original payment method where possible.',
        ],
      },
      {
        heading: 'Service changes or discontinuation',
        paragraphs: [
          'If Pixel Paper cannot maintain or make a purchased placement available because of a failure on our side, we will review an appropriate remedy, which may include a refund. A refund is not automatic for every interruption, and any decision is subject to applicable law and the circumstances of the issue.',
          'If the service is discontinued, previously purchased placements may no longer remain publicly accessible. Refund requests in that situation will be considered fairly with regard to the timing, cause, and extent of the disruption, as well as applicable law.',
        ],
      },
      {
        heading: 'Promotional placements',
        paragraphs: [
          'Promotional, complimentary, or free placements have no monetary refund value. This does not remove any rights that cannot legally be excluded.',
        ],
      },
      {
        heading: 'Contact',
        paragraphs: [
          'Use the support contact provided with your order to request a review. Business refund contact details should be added here before launch if a separate address is required.',
        ],
      },
    ],
  },
};

const NAV_ITEMS: Array<{ kind: LegalPageKind; href: string; label: string }> = [
  { kind: 'terms', href: '/terms', label: 'Terms' },
  { kind: 'privacy', href: '/privacy', label: 'Privacy' },
  { kind: 'refunds', href: '/refunds', label: 'Refunds' },
];

function upsertMeta(selector: string, attribute: string, value: string) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, selector.includes('[') ? selector.split('[')[1].split('=')[0] : attribute);
    document.head.appendChild(element);
  }
  element.setAttribute('content', value);
  return element;
}

function updateMetadata(documentPage: LegalDocument) {
  const previousTitle = document.title;
  const tracked: Array<{ element: Element; content: string | null; created: boolean }> = [];
  const entries = [
    ['meta[name="description"]', 'name', documentPage.description],
    ['meta[property="og:title"]', 'property', `Pixel Paper — ${documentPage.title}`],
    ['meta[property="og:description"]', 'property', documentPage.description],
    ['meta[property="og:url"]', 'property', `${window.location.origin}/${documentPage.kind}`],
    ['meta[name="twitter:title"]', 'name', `Pixel Paper — ${documentPage.title}`],
    ['meta[name="twitter:description"]', 'name', documentPage.description],
  ] as const;

  document.title = `Pixel Paper — ${documentPage.title}`;
  for (const [selector, attribute, value] of entries) {
    const existing = document.head.querySelector(selector);
    const element = upsertMeta(selector, attribute, value);
    tracked.push({ element, content: existing?.getAttribute('content') ?? null, created: !existing });
  }

  const canonicalSelector = 'link[rel="canonical"]';
  const existingCanonical = document.head.querySelector<HTMLLinkElement>(canonicalSelector);
  const canonical = existingCanonical ?? document.createElement('link');
  if (!existingCanonical) {
    canonical.setAttribute('rel', 'canonical');
    document.head.appendChild(canonical);
  }
  const previousCanonical = existingCanonical?.getAttribute('href') ?? null;
  canonical.setAttribute('href', `${window.location.origin}/${documentPage.kind}`);

  return () => {
    document.title = previousTitle;
    for (const item of tracked) {
      if (item.created) item.element.remove();
      else if (item.content === null) item.element.removeAttribute('content');
      else item.element.setAttribute('content', item.content);
    }
    if (existingCanonical) {
      if (previousCanonical === null) existingCanonical.removeAttribute('href');
      else existingCanonical.setAttribute('href', previousCanonical);
    } else {
      canonical.remove();
    }
  };
}

export function LegalPage({ kind }: { kind: LegalPageKind }) {
  const documentPage = DOCUMENTS[kind];

  useEffect(() => updateMetadata(documentPage), [documentPage]);

  return (
    <div className="flex min-h-screen flex-col bg-[#f2effb] font-ui text-[#191627] dark:bg-[#0b0a14] dark:text-[#f2f0fb]">
      <header className="flex items-center justify-between gap-4 border-b border-[#dcd6ec] bg-[#faf9fe]/95 px-4 py-3 dark:border-[#232037] dark:bg-[#131120]/95 sm:px-8">
        <a href="/" className="flex min-w-0 items-center gap-2.5" aria-label="Back to Pixel Paper">
          <PixelMark size={30} aria-hidden />
          <PixelWordmark size="text-base sm:text-lg" />
        </a>
        <a
          href="/"
          className="flex shrink-0 items-center gap-1.5 font-data text-[10px] font-bold uppercase tracking-wider text-[#514c62] underline-offset-4 hover:text-[#7c3aed] hover:underline dark:text-zinc-400 dark:hover:text-[#a78bfa]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to the paper
        </a>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-8 sm:py-12">
        <article className="border-2 border-[#191627] bg-[#fdfcff] p-5 shadow-xl dark:border-[#332f45] dark:bg-[#16131f] sm:p-10">
          <header className="border-b-4 border-[#191627] pb-6 dark:border-[#332f45]">
            <div className="mb-2 font-data text-[10px] font-black uppercase tracking-[0.22em] text-[#7c3aed] dark:text-[#a78bfa]">
              Pixel Paper · {documentPage.label}
            </div>
            <h1 className="font-masthead text-3xl font-black uppercase leading-none text-[#191627] dark:text-white sm:text-5xl">
              {documentPage.title}
            </h1>
            <p className="mt-4 max-w-2xl font-editorial text-base leading-relaxed text-[#514c62] dark:text-[#b4aec4]">
              {documentPage.intro}
            </p>
          </header>

          <div className="divide-y divide-[#dcd6ec] dark:divide-[#2a2740]">
            {documentPage.sections.map((section) => (
              <section key={section.heading} className="space-y-3 py-6 first:pt-7 last:pb-2">
                <h2 className="font-headline text-base font-black uppercase text-[#191627] dark:text-white sm:text-lg">
                  {section.heading}
                </h2>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph} className="max-w-3xl font-editorial text-sm leading-7 text-[#514c62] dark:text-[#b4aec4]">
                    {paragraph}
                  </p>
                ))}
              </section>
            ))}
          </div>
        </article>
      </main>

      <footer className="border-t border-[#dcd6ec] px-4 py-5 dark:border-[#232037] sm:px-8">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 font-data text-[10px] uppercase tracking-wider text-[#6f6a80] sm:flex-row sm:items-center sm:justify-between dark:text-zinc-500">
          <span>Pixel Paper · an independent digital project</span>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-2">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.kind}
                href={item.href}
                aria-current={item.kind === kind ? 'page' : undefined}
                className="font-bold underline-offset-4 hover:text-[#7c3aed] hover:underline dark:hover:text-[#a78bfa]"
              >
                {item.label}
              </a>
            ))}
            <a
              href="/"
              className="inline-flex items-center gap-1 font-bold underline-offset-4 hover:text-[#7c3aed] hover:underline dark:hover:text-[#a78bfa]"
            >
              Read the paper
              <ExternalLink className="h-3 w-3" />
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
