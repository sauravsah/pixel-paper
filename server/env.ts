/**
 * THE INTERNET TIMES — ENVIRONMENT
 * ================================
 *
 * Every secret this server needs is read here, once, and nowhere else.
 *
 * Nothing in this file is ever sent to the browser. No payment secret leaves the
 * server process: the Dodo API key and the webhook signing key are not imported
 * by any file under src/, and Vite would not expose them anyway since they carry
 * no VITE_ prefix.
 */

import dotenv from 'dotenv';

// Load `.env.local` first — the developer's real, gitignored values — then fall
// back to `.env`. Variables already present in the real environment (e.g. a
// deployment platform's own configuration) are never overridden, so production
// secrets always win over any committed file.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

export type DodoEnvironment = 'test_mode' | 'live_mode';

export interface Env {
  port: number;
  nodeEnv: string;
  isProduction: boolean;
  databaseUrl: string | undefined;
  dodoApiKey: string | undefined;
  dodoWebhookKey: string | undefined;
  dodoProductId: string | undefined;
  dodoEnvironment: DodoEnvironment;
  /** Overrides the auto-detected origin used for payment return URLs. */
  publicBaseUrl: string | undefined;
}

function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Tolerate a value that was pasted with surrounding quotes or stray spaces.
  const trimmed = value.trim().replace(/^["']|["']$/g, '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The Dodo environment, defaulting to test mode. Only an explicit `live_mode`
 * opts in to charging real cards; anything unset, misspelled or blank stays on
 * the safe side.
 */
function cleanEnvironment(value: string | undefined): DodoEnvironment {
  return clean(value) === 'live_mode' ? 'live_mode' : 'test_mode';
}

export const env: Env = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  databaseUrl: clean(process.env.DATABASE_URL),
  dodoApiKey: clean(process.env.DODO_PAYMENTS_API_KEY),
  dodoWebhookKey: clean(process.env.DODO_PAYMENTS_WEBHOOK_KEY),
  dodoProductId: clean(process.env.DODO_PRODUCT_ID),
  dodoEnvironment: cleanEnvironment(process.env.DODO_PAYMENTS_ENVIRONMENT),
  publicBaseUrl: clean(process.env.PUBLIC_BASE_URL),
};

export interface ReadinessReport {
  databaseReady: boolean;
  paymentsReady: boolean;
  webhookReady: boolean;
  missing: string[];
}

/** What is configured and what is still missing. Drives the startup banner. */
export function readiness(): ReadinessReport {
  const missing: string[] = [];

  if (!env.databaseUrl) missing.push('DATABASE_URL');
  if (!env.dodoApiKey) missing.push('DODO_PAYMENTS_API_KEY');
  if (!env.dodoProductId) missing.push('DODO_PRODUCT_ID');
  if (!env.dodoWebhookKey) missing.push('DODO_PAYMENTS_WEBHOOK_KEY');

  return {
    databaseReady: Boolean(env.databaseUrl),
    paymentsReady: Boolean(env.dodoApiKey && env.dodoProductId),
    webhookReady: Boolean(env.dodoWebhookKey),
    missing,
  };
}

/**
 * Print exactly which credentials are missing and precisely where to get them.
 *
 * Only the values that actually matter are ever mentioned.
 */
export function printStartupBanner(): void {
  const report = readiness();

  console.log('');
  console.log('  THE INTERNET TIMES');
  console.log('  ------------------');
  console.log(`  Database   ${report.databaseReady ? 'connected' : 'NOT CONFIGURED'}`);
  console.log(
    `  Payments   ${report.paymentsReady ? `configured (Dodo ${env.dodoEnvironment === 'live_mode' ? 'live' : 'test'} mode)` : 'NOT CONFIGURED'}`
  );
  console.log(`  Webhook    ${report.webhookReady ? 'signing key present' : 'NOT CONFIGURED'}`);

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

  if (!env.dodoApiKey || !env.dodoProductId) {
    console.log('  DODO_PAYMENTS_API_KEY and DODO_PRODUCT_ID');
    console.log('    app.dodopayments.com > Developer > API Keys (use a test-mode key)');
    console.log('    Create a "pay what you want" product and copy its product id.');
    console.log('');
  }

  if (!env.dodoWebhookKey) {
    console.log('  DODO_PAYMENTS_WEBHOOK_KEY');
    console.log('    app.dodopayments.com > Developer > Webhooks > add your endpoint');
    console.log('    Copy the signing secret it shows.');
    console.log('');
  }

  console.log('  Until these are set the newspaper still runs and pages still render,');
  console.log('  but no purchase can complete.');
  console.log('');
}
