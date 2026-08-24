/**
 * Create the schema and seed the six pages.
 *
 *     npm run migrate
 *
 * Safe to run as many times as you like. The server also runs this on boot, so
 * you normally never need to call it by hand — it exists for when you want to
 * confirm the database is reachable and correctly set up before starting
 * anything else.
 */

import { PRICING_CONFIG } from '../shared/pricing-config.ts';
import { closePool, isDatabaseConfigured, migrate, pingDatabase, query } from '../server/db.ts';

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error('');
    console.error('  DATABASE_URL is not set.');
    console.error('');
    console.error('  Add it to .env.local in the project root:');
    console.error('');
    console.error('    DATABASE_URL=postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres');
    console.error('');
    console.error('  Supabase dashboard > your project > Connect > ORMs / Postgres,');
    console.error('  then copy the URI connection string.');
    console.error('');
    process.exit(1);
  }

  console.log('Connecting...');
  const version = await pingDatabase();
  console.log(`Connected: ${version.split(' ').slice(0, 2).join(' ')}`);

  console.log('Applying schema...');
  await migrate();

  const pages = await query<{ page_number: number }>(
    'SELECT page_number FROM newspaper_pages ORDER BY page_number'
  );
  const counts = await query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM pixel_bookings WHERE status = 'paid')    AS paid,
       (SELECT count(*) FROM pixel_bookings WHERE status = 'pending') AS pending,
       (SELECT count(*) FROM advertisements)                          AS ads,
       (SELECT count(*) FROM orders)                                  AS orders`
  );

  const constraint = await query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conname = 'pixel_bookings_no_overlap'`
  );

  const row = counts[0] ?? {};

  console.log('');
  console.log(`  Pages            ${pages.length} (${pages.map((p) => p.page_number).join(', ')})`);
  console.log(`  Page size        ${PRICING_CONFIG.pageWidth} x ${PRICING_CONFIG.pageHeight} px`);
  console.log(`  Paid bookings    ${row.paid ?? '0'}`);
  console.log(`  Pending bookings ${row.pending ?? '0'}`);
  console.log(`  Advertisements   ${row.ads ?? '0'}`);
  console.log(`  Orders           ${row.orders ?? '0'}`);
  console.log(
    `  Overlap guard    ${constraint.length > 0 ? 'active (pixel_bookings_no_overlap)' : 'MISSING'}`
  );
  console.log('');

  if (constraint.length === 0) {
    console.error('The no-overlap exclusion constraint was not created. Stopping.');
    process.exit(1);
  }

  if (pages.length !== PRICING_CONFIG.totalPages) {
    console.error(
      `Expected ${PRICING_CONFIG.totalPages} pages but found ${pages.length}. Stopping.`
    );
    process.exit(1);
  }

  console.log('Database ready.');
}

main()
  .catch((err) => {
    console.error('');
    console.error('Migration failed:', err.message);
    if (err.message.includes('btree_gist')) {
      console.error('');
      console.error('The btree_gist extension could not be created. On Supabase this is');
      console.error('available by default; on a self-hosted Postgres you may need the');
      console.error('postgresql-contrib package, and a superuser to run CREATE EXTENSION.');
    }
    console.error('');
    process.exitCode = 1;
  })
  .finally(closePool);
