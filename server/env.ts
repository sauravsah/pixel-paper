/**
 * THE INTERNET TIMES — ENVIRONMENT
 * ================================
 *
 * Every secret this server needs is read here, once, and nowhere else.
 *
 * Nothing in this file is ever sent to the browser. The only value that reaches
 * the client is the Stripe *publishable* key, handed over deliberately by
 * GET /api/config. `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` never leave
 * the server process — they are not imported by any file under src/, and Vite
 * would not expose them anyway since they carry no VITE_ prefix.
 */

import dotenv from 'dotenv';

// Load `.env.local` first — the developer's real, gitignored values — then fall
// back to `.env`. Variables already present in the real environment (e.g. a
// deployment platform's own configuration) are never overridden, so production
// secrets always win over any committed file.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

export interface Env {
  port: number;
  nodeEnv: string;
  isProduction: boolean;
  databaseUrl: string | undefined;
  stripeSecretKey: string | undefined;
  stripePublishableKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  /** Overrides the auto-detected origin used for Stripe return URLs. */
  publicBaseUrl: string | undefined;
}

function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Tolerate a value that was pasted with surrounding quotes or stray spaces.
  const trimmed = value.trim().replace(/^["']|["']$/g, '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const env: Env = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  databaseUrl: clean(process.env.DATABASE_URL),
  stripeSecretKey: clean(process.env.STRIPE_SECRET_KEY),
  stripePublishableKey: clean(process.env.STRIPE_PUBLISHABLE_KEY),
  stripeWebhookSecret: clean(process.env.STRIPE_WEBHOOK_SECRET),
  publicBaseUrl: clean(process.env.PUBLIC_BASE_URL),
};

export interface ReadinessReport {
  databaseReady: boolean;
  stripeReady: boolean;
  webhookReady: boolean;
  missing: string[];
}

/** What is configured and what is still missing. Drives the startup banner. */
export function readiness(): ReadinessReport {
  const missing: string[] = [];

  if (!env.databaseUrl) missing.push('DATABASE_URL');
  if (!env.stripeSecretKey) missing.push('STRIPE_SECRET_KEY');
  if (!env.stripePublishableKey) missing.push('STRIPE_PUBLISHABLE_KEY');
  if (!env.stripeWebhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');

  return {
    databaseReady: Boolean(env.databaseUrl),
    stripeReady: Boolean(env.stripeSecretKey && env.stripePublishableKey),
    webhookReady: Boolean(env.stripeWebhookSecret),
    missing,
  };
}

/**
 * Print exactly which credentials are missing and precisely where to get them.
 *
 * Only the four values that actually matter are ever mentioned.
 */
export function printStartupBanner(): void {
  const report = readiness();

  console.log('');
  console.log('  THE INTERNET TIMES');
  console.log('  ------------------');
  console.log(`  Database   ${report.databaseReady ? 'connected' : 'NOT CONFIGURED'}`);
  console.log(
    `  Stripe     ${report.stripeReady ? `configured${env.stripeSecretKey?.startsWith('sk_test_') ? ' (test mode)' : ''}` : 'NOT CONFIGURED'}`
  );
  console.log(`  Webhook    ${report.webhookReady ? 'signing secret present' : 'NOT CONFIGURED'}`);

  if (report.missing.length === 0) {
    console.log('');
    console.log('  Everything is configured. The newspaper is live.');
    console.log('');
    return;
  }

  console.log('');
  console.log('  Add the following to .env.local in the project root, then restart:');
  console.log('');

  if (!env.databaseUrl) {
    console.log('  DATABASE_URL');
    console.log('    Supabase dashboard > your project > Connect > ORMs / Postgres');
    console.log('    Copy the "Connection string" (URI). It looks like:');
    console.log('    postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres');
    console.log('');
  }

  if (!env.stripeSecretKey || !env.stripePublishableKey) {
    console.log('  STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY');
    console.log('    dashboard.stripe.com/test/apikeys  (keep Test mode on)');
    console.log('    Secret key starts sk_test_, publishable key starts pk_test_');
    console.log('');
  }

  if (!env.stripeWebhookSecret) {
    console.log('  STRIPE_WEBHOOK_SECRET');
    console.log('    Run:  stripe listen --forward-to localhost:3000/api/stripe/webhook');
    console.log('    Copy the whsec_... value it prints.');
    console.log('');
  }

  console.log('  Until these are set the newspaper still runs and pages still render,');
  console.log('  but no purchase can complete.');
  console.log('');
}
