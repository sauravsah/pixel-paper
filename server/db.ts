/**
 * PIXEL PAPER — DATABASE CONNECTION
 * ========================================
 *
 * Owns the connection pool, runs the migration, and seeds the six pages.
 *
 * The pool is created lazily so the newspaper still boots and serves pages when
 * DATABASE_URL has not been set yet — it simply reports that it has no bookings.
 * That keeps the app inspectable before any credentials exist, without ever
 * faking a purchase.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { PRICING_CONFIG } from '../shared/pricing-config.ts';
import { env } from './env.ts';
import { SCHEMA_SQL } from './schema.ts';

/**
 * Namespace for advisory locks, so the per-page lock this app takes can never
 * collide with a lock taken by anything else sharing the database.
 */
const ADVISORY_LOCK_NAMESPACE = 728_149;

let pool: Pool | null = null;
let migrated = false;

export function isDatabaseConfigured(): boolean {
  return Boolean(env.databaseUrl);
}

/**
 * Managed Postgres (Supabase, Neon, RDS) terminates TLS with a chain Node does
 * not carry in its default trust store, so certificate verification is relaxed
 * for remote hosts. The connection is still encrypted. Local Postgres needs no
 * TLS at all.
 */
function sslOptionsFor(connectionString: string) {
  try {
    const { hostname } = new URL(connectionString);
    const isLocal =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    return isLocal ? undefined : { rejectUnauthorized: false };
  } catch {
    return { rejectUnauthorized: false };
  }
}

export function getPool(): Pool {
  if (!env.databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Add it to .env.local and restart the server.'
    );
  }

  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: sslOptionsFor(env.databaseUrl),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });

    // A dropped backend must not take the process down with it.
    pool.on('error', (err) => {
      console.error('[db] idle client error:', err.message);
    });
  }

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * throw. The client is always released.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already gone; the transaction died with it.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Serialise every booking attempt on a given page.
 *
 * Checking "is this rectangle free?" and then inserting a row is only safe if no
 * other transaction can slip between the two steps. Row locks cannot help here,
 * because the row that would conflict does not exist yet — the classic phantom
 * read. A transaction-scoped advisory lock on the page number closes that
 * window: concurrent attempts on the same page queue up and are evaluated one at
 * a time, while attempts on different pages stay fully parallel.
 *
 * The lock is released automatically when the transaction commits or rolls back.
 */
export async function lockPage(client: PoolClient, pageNumber: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
    ADVISORY_LOCK_NAMESPACE,
    pageNumber,
  ]);
}

/**
 * Serialize refund attempts for one provider payment. The lock is held only for
 * the surrounding transaction, so a retry can inspect provider state after an
 * earlier attempt has committed or the connection has been released.
 */
export async function lockRefund(client: PoolClient, paymentId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
    ADVISORY_LOCK_NAMESPACE,
    paymentId,
  ]);
}

/**
 * Create the schema and seed the six pages.
 *
 * Safe to run on every boot: the schema is written to be idempotent, and the
 * seed reconciles page geometry with the current config instead of inserting
 * duplicates. No bookings, advertisements or orders are ever created here — the
 * newspaper starts genuinely empty and only real payments fill it.
 */
export async function migrate(): Promise<void> {
  if (migrated) return;

  const config = PRICING_CONFIG;

  await withTransaction(async (client) => {
    await client.query(SCHEMA_SQL);

    for (let pageNumber = 1; pageNumber <= config.totalPages; pageNumber++) {
      await client.query(
        `INSERT INTO newspaper_pages (page_number, width, height, base_rate)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (page_number) DO UPDATE
           SET width = EXCLUDED.width,
               height = EXCLUDED.height,
               base_rate = EXCLUDED.base_rate`,
        [pageNumber, config.pageWidth, config.pageHeight, config.baseRate]
      );
    }

    // Guard against a stale database that was seeded with a different page
    // count. Only pages with no bookings are removed, so this can never delete
    // somebody's paid placement.
    await client.query(
      `DELETE FROM newspaper_pages p
        WHERE p.page_number > $1
          AND NOT EXISTS (
            SELECT 1 FROM pixel_bookings b WHERE b.page_number = p.page_number
          )`,
      [config.totalPages]
    );
  });

  migrated = true;
}

/** Verify the connection and report the server version. */
export async function pingDatabase(): Promise<string> {
  const rows = await query<{ version: string }>('SELECT version() AS version');
  return rows[0]?.version ?? 'unknown';
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    migrated = false;
  }
}
