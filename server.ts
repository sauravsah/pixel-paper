/**
 * THE INTERNET TIMES — SERVER ENTRY POINT
 * =======================================
 *
 * Wires the API, the Dodo webhook, and Vite (dev) or the built assets (prod).
 *
 * MIDDLEWARE ORDER MATTERS
 * ------------------------
 * The webhook is mounted with `express.raw` before `express.json`. Dodo signs
 * the exact bytes of the request body, so if a JSON parser touches it first the
 * signature can never be verified again. This ordering is load-bearing; moving
 * the webhook below the JSON parser breaks every payment.
 */

import path from 'node:path';

import express, { type Request, type Response } from 'express';
import cors from 'cors';

import { env, printStartupBanner, readiness } from './server/env.ts';
import { closePool, isDatabaseConfigured, migrate, pingDatabase } from './server/db.ts';
import { createApiRouter } from './server/routes.ts';
import { handleDodoWebhook } from './server/webhook.ts';
import { MAX_IMAGE_BYTES } from './shared/field-rules.ts';

async function startServer(): Promise<void> {
  const app = express();

  app.disable('x-powered-by');

  // ---------------------------------------------------------------------------
  // Dodo webhook. Raw body, mounted first. Do not move.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/webhooks/dodo',
    express.raw({ type: '*/*', limit: '1mb' }),
    handleDodoWebhook
  );

  // ---------------------------------------------------------------------------
  // Everything else
  // ---------------------------------------------------------------------------
  app.use(cors());
  // A checkout body can carry a base64-encoded image attachment. An image up to
  // MAX_IMAGE_BYTES inflates by ~4/3 once base64-encoded, so the JSON body can
  // approach ~1.34× that size. Allow 2× to clear the encoding plus the rest of
  // the form with margin — and to stay in lockstep if the image cap ever changes.
  app.use(express.json({ limit: MAX_IMAGE_BYTES * 2 }));

  app.use('/api', createApiRouter());

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'not-found', message: 'No such endpoint.' });
  });

  // ---------------------------------------------------------------------------
  // Database
  // ---------------------------------------------------------------------------
  if (isDatabaseConfigured()) {
    try {
      await pingDatabase();
      await migrate();
      console.log('[db] schema up to date; six pages ready.');
    } catch (err: any) {
      // A database problem must not stop the newspaper from being readable, and
      // it must be impossible to miss in the log.
      console.error('');
      console.error('  DATABASE ERROR');
      console.error(`  ${err.message}`);
      console.error('');
      console.error('  The site will start, but no purchase can complete until this is fixed.');
      console.error('  Run `npm run migrate` for a more detailed report.');
      console.error('');
    }
  }

  // ---------------------------------------------------------------------------
  // Vite in development, built assets in production
  // ---------------------------------------------------------------------------
  if (env.isProduction) {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    // Imported lazily so `vite` is not required in a production install.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(env.port, '0.0.0.0', () => {
    printStartupBanner();
    console.log(`  http://localhost:${env.port}`);
    console.log('');

    const missing = readiness().missing;
    if (missing.length === 0) {
      console.log(
        `  Ready to take payments (Dodo ${env.dodoEnvironment === 'live_mode' ? 'live' : 'test'} mode).`
      );
      console.log('');
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down.`);
    server.close();
    await closePool().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
