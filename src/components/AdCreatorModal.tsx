/**
 * CREATE YOUR AD
 * ==============
 *
 * Two steps and then checkout: write the ad, check the receipt, pay.
 *
 * WHAT THIS COMPONENT DELIBERATELY CANNOT DO
 * ------------------------------------------
 * It cannot say what the space costs, and it cannot say the space is available.
 * It shows a price so a buyer knows what they are agreeing to, but the number in
 * the button is only ever a copy of what `/api/quote` returned; the amount that
 * reaches the payment provider is recomputed from the coordinates inside the same
 * locked transaction that re-checks availability. If the two disagree, the
 * checkout is refused rather than reconciled.
 *
 * There is also no success step here, which is not an omission. Paying means
 * leaving this page entirely for the payment provider's own checkout, so this
 * component is destroyed at that moment. The confirmation is rendered by
 * ClaimedConfirmation from the booking id the provider returns with — the only
 * place a claim can be confirmed, because it is the only place that asks the
 * server.
 *
 * NO SIGN-IN
 * ----------
 * Buying a rectangle should not require an account. An email address is
 * collected for the receipt and nothing else; there is no password, no session,
 * and no "your purchases" to log back into. Anyone can buy as many spaces as
 * they like, in one sitting or across months.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Globe,
  ImageIcon,
  Loader2,
  Lock,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';

import { MAX_IMAGE_BYTES, MAX_LENGTHS, parseSafeImageSrc, parseSafeUrl } from '../../shared/field-rules.ts';
import type { PricingConfig } from '../../shared/pricing-config.ts';
import { ApiError, type AdDraft, type PixelSelection } from '../types.ts';
import { postCheckout } from '../lib/api.ts';
import { displayUrl, pixels as fmtPixels, rate as fmtRate, usd } from '../lib/selection.ts';

type Step = 'create' | 'review';

interface AdCreatorModalProps {
  isOpen: boolean;
  selection: PixelSelection | null;
  config: PricingConfig;
  onClose: () => void;
  /** Called when the area turned out to be taken, so the page can refresh. */
  onAreaLost: () => void;
}

/** A blank field set. Kept out of the component so it is not rebuilt per render. */
const EMPTY: AdDraft = {
  brandName: '',
  headline: '',
  description: '',
  destinationUrl: '',
  imageUrl: '',
  ctaText: '',
  buyerEmail: '',
};

export const AdCreatorModal: React.FC<AdCreatorModalProps> = ({
  isOpen,
  selection,
  config,
  onClose,
  onAreaLost,
}) => {
  const [step, setStep] = useState<Step>('create');
  const [draft, setDraft] = useState<AdDraft>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // A logo-only ad is just an image that links somewhere — no headline, and the
  // brand name is optional. This is UI state, not part of the draft that is sent:
  // the server and the page both infer "logo-only" from an ad that has an image
  // and no headline, so all this does is shape the form and strip the hidden
  // fields at submit. It persists with the typed fields, so placing several logos
  // in a row does not keep switching itself off.
  const [logoOnly, setLogoOnly] = useState(false);

  // The attached image lives in the draft as a data URL; this only holds the
  // file's name for display and a handle to the (visually hidden) file input so
  // Replace and Remove can drive it.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);

  // A fresh selection means a fresh form step, but the typed fields survive —
  // someone who picked the wrong rectangle should not have to retype their
  // headline. Buying several spaces in a row is expected, not unusual.
  useEffect(() => {
    if (isOpen) {
      setStep('create');
      setServerError(null);
      setFieldErrors({});
    }
  }, [isOpen, selection?.x, selection?.y, selection?.pageNumber]);

  // Escape closes, as it does everywhere else.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, submitting]);

  const set = <K extends keyof AdDraft>(key: K, value: AdDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // Reading a picked file into the draft. The bytes never leave the browser
  // until checkout: they are turned into a `data:` URL here and travel inside
  // the ad, so the same `imageUrl` field carries either a hosted address or an
  // attachment. The cheap size check happens before the read; the real gate is
  // `parseSafeImageSrc`, the exact rule the server will re-apply.
  const handleImagePick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fail = (message: string) => {
      setFieldErrors((prev) => ({ ...prev, imageUrl: message }));
      if (fileInputRef.current) fileInputRef.current.value = '';
    };

    if (file.size > MAX_IMAGE_BYTES) {
      fail('That image is over 1 MB. Please choose a smaller file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const safe = parseSafeImageSrc(result);
      if (!safe) {
        fail('The image must be a PNG, JPEG, GIF, WEBP or SVG file under 1 MB.');
        return;
      }
      setImageName(file.name);
      set('imageUrl', safe);
    };
    reader.onerror = () => fail('That file could not be read. Please try another one.');
    reader.readAsDataURL(file);
  };

  const handleImageRemove = () => {
    setImageName(null);
    set('imageUrl', '');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const trimmed = useMemo(
    () => ({
      brandName: draft.brandName.trim(),
      headline: draft.headline.trim(),
      description: draft.description.trim(),
      destinationUrl: draft.destinationUrl.trim(),
      imageUrl: draft.imageUrl.trim(),
      ctaText: draft.ctaText.trim(),
      buyerEmail: draft.buyerEmail.trim(),
    }),
    [draft]
  );

  // In logo-only mode the image is the ad, so it and the link are what gate the
  // step; otherwise a brand and headline are needed, as before.
  const readyForReview = logoOnly
    ? trimmed.imageUrl.length > 0 && trimmed.destinationUrl.length > 0
    : trimmed.brandName.length > 0 &&
      trimmed.headline.length > 0 &&
      trimmed.destinationUrl.length > 0;

  /**
   * The same URL rule the server will apply, run here purely so a typo is caught
   * in the field instead of at the payment button. `parseSafeUrl` is used only as
   * a yes-or-no; the address that gets stored is the one the server normalises.
   */
  const urlLooksWrong =
    trimmed.destinationUrl.length > 0 && parseSafeUrl(trimmed.destinationUrl) === null;
  const imageLooksWrong =
    trimmed.imageUrl.length > 0 && parseSafeImageSrc(trimmed.imageUrl) === null;

  if (!isOpen || !selection) return null;

  const { quote } = selection;

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  const handleCheckout = async () => {
    setSubmitting(true);
    setServerError(null);
    setFieldErrors({});

    try {
      // A logo-only ad is stored with no text at all, so the page and the detail
      // view render it as just the linked image. The hidden fields are dropped
      // here rather than cleared from the draft, so un-ticking restores them.
      const submission = logoOnly
        ? { ...trimmed, headline: '', description: '', ctaText: '' }
        : trimmed;

      // Coordinates and ad copy only. No price — the server works that out, and
      // would reject a price sent from here anyway.
      const response = await postCheckout({
        pageNumber: selection.pageNumber,
        x: selection.x,
        y: selection.y,
        width: selection.width,
        height: selection.height,
        ad: submission,
      });

      // Leaving for the provider's hosted page. Card details are typed there, on
      // the provider's domain, and never touch this application or its database.
      window.location.href = response.checkoutUrl;
    } catch (error) {
      setSubmitting(false);

      if (!(error instanceof ApiError)) {
        setServerError('Something went wrong. Please try again.');
        return;
      }

      switch (error.code) {
        case 'area-unavailable':
          setServerError(
            'Somebody claimed part of that area while you were writing. Nothing has been charged — pick another space and your text will still be here.'
          );
          onAreaLost();
          break;

        case 'invalid-advertisement': {
          const map: Record<string, string> = {};
          for (const field of error.fields ?? []) map[field.field] = field.message;
          setFieldErrors(map);
          setStep('create');
          setServerError('Please fix the highlighted fields.');
          break;
        }

        case 'payments-not-configured':
          setServerError(
            'Payments are not switched on yet. Dodo Payments is not configured on the server.'
          );
          break;

        case 'invalid-selection':
          setServerError('That selection is no longer valid. Please draw it again.');
          onAreaLost();
          break;

        case 'network':
          setServerError('Could not reach the server. Check your connection and try again.');
          break;

        default:
          setServerError(error.message);
      }
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const inputClass = (field: string) =>
    `w-full p-2 bg-[#faf9fe] dark:bg-[#131120] border text-[#191627] dark:text-white rounded-xs focus:outline-hidden focus:ring-1 ${
      fieldErrors[field]
        ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
        : 'border-[#e0dcf0] dark:border-[#332f45] focus:border-[#7c3aed] focus:ring-[#7c3aed] dark:focus:border-[#a78bfa] dark:focus:ring-[#a78bfa]'
    }`;

  const FieldError: React.FC<{ field: string }> = ({ field }) =>
    fieldErrors[field] ? (
      <p className="mt-1 font-data text-[10px] text-red-600 dark:text-red-400">
        {fieldErrors[field]}
      </p>
    ) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-xs sm:p-5 lg:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Create your advertisement"
    >
      <div className="relative my-auto w-full max-w-5xl rounded-xs border-4 border-[#191627] bg-[#faf9fe] p-4 text-[#191627] shadow-2xl transition-colors duration-200 dark:border-[#332f45] dark:bg-[#131120] dark:text-[#f2f0fb] sm:p-6 lg:p-7">
        <button
          onClick={onClose}
          disabled={submitting}
          className="absolute right-4 top-4 z-10 cursor-pointer rounded-xs p-2 text-[#191627] transition-colors hover:bg-[#e6e1f2] disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-[#221f36]"
          title="Close"
        >
          <X className="h-5 w-5" />
        </button>

        {serverError && (
          <div className="mb-4 flex items-start gap-2 rounded-xs border border-red-300 bg-red-100 p-3 font-data text-xs text-red-800 dark:border-red-800 dark:bg-red-950/80 dark:text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
            <span className="flex-1">{serverError}</span>
            <button
              onClick={() => setServerError(null)}
              className="shrink-0 text-xs font-bold underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* ==================================================================
            STEP 1 — WRITE THE AD
            ================================================================== */}
        {step === 'create' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setServerError(null);
              setStep('review');
            }}
            className="space-y-5"
          >
            <header className="border-b-2 border-[#191627] pb-4 pr-10 dark:border-[#332f45]">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5 font-data text-[11px] font-black uppercase tracking-wider text-[#7c3aed] dark:text-[#a78bfa]">
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>Permanent pixel placement</span>
                  </div>
                  <h2 className="font-headline text-2xl font-black uppercase tracking-tight text-[#191627] dark:text-white sm:text-3xl">
                    Create your ad
                  </h2>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 font-data text-xs text-[#514c62] dark:text-[#a49eb6]">
                    <span className="rounded-xs bg-black/5 px-1.5 py-0.5 font-bold text-[#191627] dark:bg-white/10 dark:text-white">
                      Page {selection.pageNumber}
                    </span>
                    <span>•</span>
                    <span className="font-bold text-[#191627] dark:text-zinc-200">
                      {selection.width} × {selection.height} Pixel Units
                    </span>
                    <span>•</span>
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {fmtPixels(quote.pixelCount)} pixels
                    </span>
                  </div>
                </div>

                <div className="rounded-xs border-2 border-emerald-600 bg-emerald-50 px-4 py-2 text-right shadow-xs dark:border-emerald-500 dark:bg-emerald-950/70">
                  <div className="font-headline text-2xl font-black leading-none text-emerald-700 dark:text-emerald-400 sm:text-3xl">
                    {usd(quote.totalPrice)}
                  </div>
                  <div className="mt-0.5 font-data text-[10px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                    One-time · permanent
                  </div>
                </div>
              </div>
            </header>

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
              {/* ---------- Fields ---------- */}
              <div className="space-y-4 lg:col-span-6">
                <fieldset className="space-y-2 rounded-xs border border-[#e0dcf0] bg-white p-3.5 dark:border-[#2f2b44] dark:bg-[#1a1726]">
                  <legend className="flex w-full items-center justify-between font-data text-[10px] font-bold uppercase tracking-wider text-[#7c3aed] dark:text-[#a78bfa]">
                    <span>Identity</span>
                    <span className="text-[9px] font-normal text-zinc-400">
                      {logoOnly ? 'Optional' : 'Required'}
                    </span>
                  </legend>

                  <label className="mb-1 block font-data text-xs font-bold uppercase text-[#191627] dark:text-zinc-200">
                    Brand / creator name{' '}
                    {logoOnly && <span className="font-normal text-zinc-400">— optional</span>}
                  </label>
                  <input
                    type="text"
                    required={!logoOnly}
                    maxLength={MAX_LENGTHS.brandName}
                    value={draft.brandName}
                    onChange={(e) => set('brandName', e.target.value)}
                    placeholder="Linear, Acme Corp, Jane Doe"
                    className={`${inputClass('brandName')} font-ui text-sm`}
                  />
                  <FieldError field="brandName" />
                </fieldset>

                {/* Image and button. This sits high in the form on purpose: the
                    logo-only switch it carries decides whether a headline and
                    brand are even needed, so a buyer meets that choice before
                    writing copy they might not use. */}
                <fieldset className="space-y-2.5 rounded-xs border border-[#e0dcf0] bg-white p-3.5 dark:border-[#2f2b44] dark:bg-[#1a1726]">
                  <legend className="flex w-full items-center justify-between font-data text-[10px] font-bold uppercase tracking-wider text-[#7c3aed] dark:text-[#a78bfa]">
                    <span>Image and button</span>
                    <span className="text-[9px] font-normal text-zinc-400">
                      {logoOnly ? 'Logo required' : 'Optional'}
                    </span>
                  </legend>

                  {/* The logo-only switch. Someone placing just a profile or startup
                      mark can turn off the headline and copy entirely and pay for a
                      small space that is only the logo, linked to their address. */}
                  <label className="flex cursor-pointer items-start gap-2 rounded-xs border border-[#e0dcf0] bg-[#f6f3fe] p-2.5 dark:border-[#2a2740] dark:bg-[#171526]">
                    <input
                      type="checkbox"
                      checked={logoOnly}
                      onChange={(e) => setLogoOnly(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[#7c3aed]"
                    />
                    <span className="font-data text-[11px] leading-snug text-[#514c62] dark:text-zinc-300">
                      <span className="font-black uppercase tracking-wider text-[#191627] dark:text-white">
                        Just my logo — no headline or text
                      </span>
                      <br />
                      Show only the logo below, linked to your address. Good for a profile or
                      startup mark when you want to buy just a little space.
                    </span>
                  </label>

                  <div>
                    <label className="mb-1 flex items-center gap-1 font-data text-xs font-bold uppercase text-[#191627] dark:text-zinc-200">
                      <ImageIcon className="h-3 w-3 text-blue-600 dark:text-blue-400" />
                      <span>{logoOnly ? 'Logo image' : 'Image or logo'}</span>
                    </label>

                    {/* Once picked, the file lives in the draft as a data URL. The
                        input itself is visually hidden and driven by the buttons
                        below: a file input cannot be styled, and its value cannot
                        be set from code, only cleared. */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                      onChange={handleImagePick}
                      className="sr-only"
                    />

                    {draft.imageUrl ? (
                      <div className="flex items-center gap-3 rounded-xs border border-[#e0dcf0] bg-[#faf9fe] p-2 dark:border-[#332f45] dark:bg-[#131120]">
                        <img
                          src={draft.imageUrl}
                          alt=""
                          className="h-12 w-12 shrink-0 rounded-xs border border-[#e0dcf0] object-contain dark:border-[#332f45]"
                        />
                        <span className="min-w-0 flex-1 truncate font-data text-[11px] text-[#514c62] dark:text-zinc-300">
                          {imageName ?? 'Selected image'}
                        </span>
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="shrink-0 cursor-pointer font-data text-[10px] font-bold uppercase tracking-wider text-[#7c3aed] underline dark:text-[#a78bfa]"
                        >
                          Replace
                        </button>
                        <button
                          type="button"
                          onClick={handleImageRemove}
                          className="shrink-0 cursor-pointer font-data text-[10px] font-bold uppercase tracking-wider text-red-600 underline dark:text-red-400"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className={`flex w-full items-center justify-center gap-2 rounded-xs border border-dashed p-3 font-data text-xs font-bold uppercase tracking-wider transition-colors ${
                          fieldErrors.imageUrl
                            ? 'border-red-500 text-red-600 dark:text-red-400'
                            : 'border-[#afa8c2] text-[#514c62] hover:border-[#7c3aed] hover:text-[#7c3aed] dark:border-[#332f45] dark:text-zinc-300 dark:hover:border-[#a78bfa] dark:hover:text-[#a78bfa]'
                        }`}
                      >
                        <Upload className="h-4 w-4" />
                        <span>Choose image from your device</span>
                      </button>
                    )}
                    <FieldError field="imageUrl" />
                    <p className="mt-1 font-data text-[10px] text-[#6f6a80] dark:text-zinc-500">
                      Choose an image from your device — PNG, JPEG, GIF, WEBP or SVG, up to 1 MB.
                      It becomes part of your ad.
                    </p>
                  </div>

                  {/* A logo that is itself the link needs no separate button. */}
                  {!logoOnly && (
                    <div>
                      <label className="mb-1 block font-data text-xs font-bold uppercase text-[#191627] dark:text-zinc-200">
                        Button text
                      </label>
                      <input
                        type="text"
                        maxLength={MAX_LENGTHS.ctaText}
                        value={draft.ctaText}
                        onChange={(e) => set('ctaText', e.target.value)}
                        placeholder="Read more"
                        className={`${inputClass('ctaText')} font-data text-xs uppercase`}
                      />
                      <FieldError field="ctaText" />
                    </div>
                  )}
                </fieldset>

                {/* A logo-only ad has no headline or description, so this whole
                    section is hidden while that mode is on. */}
                {!logoOnly && (
                  <fieldset className="space-y-2.5 rounded-xs border border-[#e0dcf0] bg-white p-3.5 dark:border-[#2f2b44] dark:bg-[#1a1726]">
                    <legend className="flex w-full items-center justify-between font-data text-[10px] font-bold uppercase tracking-wider text-[#7c3aed] dark:text-[#a78bfa]">
                      <span>Message</span>
                      <span className="text-[9px] font-normal text-zinc-400">Headline required</span>
                    </legend>

                    <div>
                      <label className="mb-1 block font-data text-xs font-bold uppercase text-[#191627] dark:text-zinc-200">
                        Headline
                      </label>
                      <input
                        type="text"
                        required
                        maxLength={MAX_LENGTHS.headline}
                        value={draft.headline}
                        onChange={(e) => set('headline', e.target.value)}
                        placeholder="The future of issue tracking"
                        className={`${inputClass('headline')} font-headline text-sm font-bold`}
                      />
                      <FieldError field="headline" />
                    </div>

                    <div>
                      <label className="mb-1 block font-data text-xs font-bold uppercase text-[#191627] dark:text-zinc-200">
                        Short description{' '}
                        <span className="font-normal text-zinc-400">— optional</span>
                      </label>
                      <textarea
                        rows={2}
                        maxLength={MAX_LENGTHS.description}
                        value={draft.description}
                        onChange={(e) => set('description', e.target.value)}
                        placeholder="A brief message for readers."
                        className={`${inputClass('description')} font-editorial text-xs`}
                      />
                      <FieldError field="description" />
                      {selection.width < 300 || selection.height < 200 ? (
                        <p className="mt-1 font-data text-[10px] text-[#6f6a80] dark:text-zinc-500">
                          Your space is small, so the description may not be shown on the page.
                          It will still appear when a reader opens your ad.
                        </p>
                      ) : null}
                    </div>
                  </fieldset>
                )}

                <fieldset className="space-y-2 rounded-xs border border-[#e0dcf0] bg-white p-3.5 dark:border-[#2f2b44] dark:bg-[#1a1726]">
                  <legend className="flex w-full items-center justify-between font-data text-[10px] font-bold uppercase tracking-wider text-[#7c3aed] dark:text-[#a78bfa]">
                    <span>Destination</span>
                    <span className="text-[9px] font-normal text-zinc-400">Required</span>
                  </legend>

                  <label className="mb-1 flex items-center gap-1 font-data text-xs font-bold uppercase text-[#191627] dark:text-zinc-200">
                    <Globe className="h-3 w-3 text-blue-600 dark:text-blue-400" />
                    <span>Where your ad links to</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={MAX_LENGTHS.url}
                    value={draft.destinationUrl}
                    onChange={(e) => set('destinationUrl', e.target.value)}
                    placeholder="https://myproject.com"
                    className={`${inputClass('destinationUrl')} font-data text-xs`}
                  />
                  <FieldError field="destinationUrl" />
                  {urlLooksWrong && !fieldErrors.destinationUrl && (
                    <p className="font-data text-[10px] text-amber-700 dark:text-amber-400">
                      That does not look like a web address yet.
                    </p>
                  )}
                  <p className="font-data text-[10px] text-[#6f6a80] dark:text-zinc-500">
                    Web addresses only (http or https). If you leave off the https://, we will
                    add it.
                  </p>
                </fieldset>

                <fieldset className="space-y-2 rounded-xs border border-[#e0dcf0] bg-white p-3.5 dark:border-[#2f2b44] dark:bg-[#1a1726]">
                  <legend className="flex w-full items-center justify-between font-data text-[10px] font-bold uppercase tracking-wider text-[#7c3aed] dark:text-[#a78bfa]">
                    <span>Receipt</span>
                    <span className="text-[9px] font-normal text-zinc-400">Optional</span>
                  </legend>

                  <label className="mb-1 block font-data text-xs font-bold uppercase text-[#191627] dark:text-zinc-200">
                    Email for your receipt
                  </label>
                  <input
                    type="email"
                    maxLength={MAX_LENGTHS.email}
                    value={draft.buyerEmail}
                    onChange={(e) => set('buyerEmail', e.target.value)}
                    placeholder="you@example.com"
                    className={`${inputClass('buyerEmail')} font-data text-xs`}
                  />
                  <FieldError field="buyerEmail" />
                  <p className="font-data text-[10px] text-[#6f6a80] dark:text-zinc-500">
                    No account, no password. You will also be asked for an email at payment.
                  </p>
                </fieldset>
              </div>

              {/* ---------- Preview ---------- */}
              <div className="space-y-3 lg:col-span-6">
                <div className="flex items-center justify-between border-b border-[#e0dcf0] pb-1.5 dark:border-[#2f2b44]">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                    <span className="font-data text-xs font-black uppercase tracking-wide text-[#191627] dark:text-white">
                      Live newspaper preview
                    </span>
                  </div>
                  <span className="font-data text-[10px] font-bold text-[#7c3aed] dark:text-[#a78bfa]">
                    {selection.width} × {selection.height} Pixel Units
                  </span>
                </div>

                <p className="font-data text-[11px] text-[#6f6a80] dark:text-zinc-400">
                  Drawn at the shape you bought, in the paper's own typeface.
                </p>

                <div className="relative flex min-h-[360px] items-center justify-center rounded-xs border-2 border-dashed border-[#afa8c2] bg-[#f2effb] p-4 shadow-inner dark:border-[#332f45] dark:bg-[#0b0a14] sm:p-6">
                  <div className="pointer-events-none absolute inset-0 flex select-none items-center justify-center text-center font-masthead text-5xl font-black uppercase text-black opacity-10 dark:text-white">
                    Pixel Press
                  </div>

                  {/* Held at the real aspect ratio of the purchase, so the
                      preview is not quietly flattering. */}
                  <div
                    className="relative z-10 flex w-full max-w-md flex-col overflow-hidden border-2 border-[#191627] bg-[#fffeff] text-[#191627] shadow-2xl dark:border-[#413c54] dark:bg-[#1a1726] dark:text-[#f2f0fb]"
                    style={{ aspectRatio: `${selection.width} / ${selection.height}` }}
                  >
                    {logoOnly ? (
                      <>
                        {/* On the page a logo-only ad is just the linked image, so
                            the preview drops the headline and description and shows
                            the logo filling the space, with the link beneath. */}
                        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/5 p-3 dark:bg-black/30">
                          {trimmed.imageUrl ? (
                            <img
                              src={trimmed.imageUrl}
                              alt={trimmed.brandName || 'Your logo'}
                              referrerPolicy="no-referrer"
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <span className="text-center font-data text-[11px] font-bold uppercase tracking-wider opacity-40">
                              Your logo goes here
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1 border-t border-current/20 px-3 py-1.5 font-data text-[11px]">
                          <ExternalLink className="h-3 w-3 shrink-0" />
                          <span className="truncate font-bold underline opacity-90">
                            {trimmed.destinationUrl
                              ? displayUrl(trimmed.destinationUrl)
                              : 'yourdestination.com'}
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-2 border-b border-current/20 px-3 py-1.5 font-data text-[10px]">
                          <span className="truncate font-black uppercase tracking-wider">
                            {trimmed.brandName || 'Your name'}
                          </span>
                          <span className="shrink-0 font-bold opacity-60">
                            {fmtPixels(quote.pixelCount)} Pixel Units
                          </span>
                        </div>

                        <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2">
                          {trimmed.imageUrl && (
                            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/5 dark:bg-black/30">
                              <img
                                src={trimmed.imageUrl}
                                alt=""
                                referrerPolicy="no-referrer"
                                className="h-full w-full object-contain"
                              />
                            </div>
                          )}

                          <h3 className="font-headline text-lg font-black uppercase leading-tight tracking-tight sm:text-xl">
                            {trimmed.headline || 'Your headline'}
                          </h3>

                          {trimmed.description ? (
                            <p className="line-clamp-4 font-editorial text-xs leading-snug opacity-85 sm:text-sm">
                              {trimmed.description}
                            </p>
                          ) : (
                            <p className="font-editorial text-xs italic opacity-40">
                              An optional sentence or two about what you are linking to.
                            </p>
                          )}
                        </div>

                        <div className="flex items-center justify-between gap-2 border-t border-current/20 px-3 py-1.5 font-data text-[11px]">
                          <span className="flex min-w-0 items-center gap-1 truncate font-bold underline opacity-90">
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {trimmed.destinationUrl
                                ? displayUrl(trimmed.destinationUrl)
                                : 'yourdestination.com'}
                            </span>
                          </span>

                          {trimmed.ctaText && (
                            <span className="shrink-0 bg-[#191627] px-2 py-0.5 text-[9px] font-black uppercase text-white dark:bg-[#f2f0fb] dark:text-[#191627]">
                              {trimmed.ctaText}
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-2 rounded-xs border border-[#e0dcf0] bg-[#f0edfa] p-2.5 font-data text-[11px] text-[#514c62] dark:border-[#2a2740] dark:bg-[#171526] dark:text-zinc-400">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    <strong>One payment, no expiry.</strong> Once paid, these pixels are yours.
                    There is no renewal, no subscription and no date this comes down.
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-col items-center justify-between gap-3 border-t-2 border-[#191627] pt-4 dark:border-[#332f45] sm:flex-row">
              <button
                type="button"
                onClick={onClose}
                className="w-full cursor-pointer py-1 text-center font-data text-xs text-zinc-500 underline hover:text-black dark:hover:text-white sm:w-auto sm:text-left"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={!readyForReview || urlLooksWrong || imageLooksWrong}
                className={`flex w-full items-center justify-center gap-2 rounded-xs px-8 py-3.5 font-ui text-xs font-black uppercase tracking-wider shadow-xl transition-all sm:w-auto sm:text-sm ${
                  readyForReview && !urlLooksWrong && !imageLooksWrong
                    ? 'accent-button cursor-pointer text-white hover:scale-[1.02] active:scale-95'
                    : 'cursor-not-allowed bg-zinc-400 text-white opacity-60 dark:bg-zinc-700'
                }`}
              >
                <span>Review — {usd(quote.totalPrice)}</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </form>
        )}

        {/* ==================================================================
            STEP 2 — THE RECEIPT
            ================================================================== */}
        {step === 'review' && (
          <div className="space-y-6">
            <header className="border-b-2 border-[#191627] pb-3 pr-10 dark:border-[#332f45]">
              <div className="mb-1 flex items-center gap-1.5 font-data text-xs font-bold uppercase tracking-wider text-[#7c3aed] dark:text-[#a78bfa]">
                <CreditCard className="h-4 w-4" />
                <span>Confirm permanent placement</span>
              </div>
              <h2 className="font-headline text-2xl font-black uppercase tracking-tight text-[#191627] dark:text-white sm:text-3xl">
                Check and pay
              </h2>
            </header>

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
              {/* ---------- Itemised ---------- */}
              <div className="space-y-3 rounded-xs border-2 border-[#191627] bg-white p-4 font-data text-xs dark:border-[#332f45] dark:bg-[#1b1826] lg:col-span-6 sm:p-5">
                {(
                  [
                    ['Publication', 'Pixel Press'],
                    ['Page', `Page ${selection.pageNumber} of ${config.totalPages}`],
                    ['Position', quote.positionLabel],
                    [
                      'Area',
                      `${selection.width} × ${selection.height} Pixel Units at (${selection.x}, ${selection.y})`,
                    ],
                    ['Pixel Units', fmtPixels(quote.pixelCount)],
                    ['Base rate', `${fmtRate(quote.baseRate)} per pixel`],
                    ['Page multiplier', `×${quote.pageMultiplier.toFixed(2)}`],
                    ['Position multiplier', `×${quote.positionMultiplier.toFixed(2)}`],
                    ['Effective rate', `${fmtRate(quote.effectiveRate)} per pixel`],
                    // A logo-only ad has no headline; note the shape, and drop the
                    // brand row when it was left blank rather than showing it empty.
                    ...(logoOnly ? ([['Format', 'Logo only']] as [string, string][]) : []),
                    ...(trimmed.brandName
                      ? ([['Brand', trimmed.brandName]] as [string, string][])
                      : []),
                    ['Links to', displayUrl(trimmed.destinationUrl)],
                  ] as [string, string][]
                ).map(([label, value]) => (
                  <div
                    key={label}
                    className="flex justify-between gap-4 border-b border-[#e0dcf0] pb-2 dark:border-[#2a2740]"
                  >
                    <span className="shrink-0 text-[#555] dark:text-zinc-400">{label}</span>
                    <strong className="truncate text-right text-[#191627] dark:text-white">
                      {value}
                    </strong>
                  </div>
                ))}

                <div className="flex justify-between gap-4 pt-2 text-base font-black text-[#191627] dark:text-white">
                  <div>
                    <div>One-time payment</div>
                    <div className="font-normal text-[10px] text-zinc-500">
                      Recalculated by the server before you pay
                    </div>
                  </div>
                  <span className="text-xl font-bold text-emerald-700 dark:text-emerald-400">
                    {usd(quote.totalPrice)} USD
                  </span>
                </div>

                {quote.minimumApplied && (
                  <p className="text-[10px] uppercase tracking-wider text-[#6f6a80] dark:text-zinc-500">
                    A minimum charge of {usd(config.minChargeCents / 100)} applies to very small
                    areas.
                  </p>
                )}
              </div>

              {/* ---------- What happens next ---------- */}
              <div className="space-y-3 lg:col-span-6">
                <div className="font-data text-xs font-bold uppercase text-[#191627] dark:text-white">
                  What happens next
                </div>

                <ol className="space-y-2.5">
                  {[
                    'You are taken to a secure checkout page to pay. Your card details are typed there and never reach us.',
                    'The payment provider tells our server directly that the payment succeeded. That message is signature-checked before it is believed.',
                    'Your pixels are marked claimed and your ad goes live on the page. Permanently.',
                  ].map((text, index) => (
                    <li key={index} className="flex gap-2.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#191627] font-data text-[10px] font-black text-white dark:bg-[#f2f0fb] dark:text-[#191627]">
                        {index + 1}
                      </span>
                      <span className="font-editorial text-xs leading-snug text-[#514c62] dark:text-zinc-400">
                        {text}
                      </span>
                    </li>
                  ))}
                </ol>

                <div className="flex items-start gap-2 rounded-xs border border-[#e0dcf0] bg-[#ece8f8] p-3 font-data text-[11px] text-[#514c62] dark:border-[#2a2740] dark:bg-[#171526] dark:text-zinc-400">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    Your area is held while you pay. If the payment does not complete, the hold
                    lapses after {config.pendingHoldMinutes} minutes and the space returns to the
                    page.
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-col items-center justify-between gap-3 border-t-2 border-[#191627] pt-4 dark:border-[#332f45] sm:flex-row">
              <button
                type="button"
                onClick={() => setStep('create')}
                disabled={submitting}
                className="w-full cursor-pointer font-data text-xs text-zinc-500 underline hover:text-black disabled:opacity-40 dark:hover:text-white sm:w-auto"
              >
                ← Back to edit
              </button>

              <button
                type="button"
                onClick={handleCheckout}
                disabled={submitting}
                className="accent-button flex w-full cursor-pointer items-center justify-center gap-2 rounded-xs px-8 py-3.5 font-ui text-xs font-black uppercase tracking-wider text-white shadow-xl transition-all hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:text-sm"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Holding your space…</span>
                  </>
                ) : (
                  <>
                    <span>Continue to checkout — {usd(quote.totalPrice)}</span>
                    <CheckCircle2 className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
