#!/usr/bin/env node
/**
 * refresh-analytics.mjs - rebuild the materialised assessor analytics (migration 0147).
 *
 *   npm run analytics:refresh
 *
 * Run after anything that writes records outside the history seeder (which refreshes on its own).
 * The app never refreshes: a page that rebuilt the views on read would be the timeout this fixes.
 */
import { connect } from './lib/kit-seed.mjs';

const client = await connect();
try {
  const t0 = Date.now();
  await client.query(`SET statement_timeout = 0`);
  await client.query(`SELECT refresh_assessor_analytics()`);
  const { rows } = await client.query(`SELECT count(*)::int AS assessors, sum(n_records)::int AS records FROM mv_assessor_adjusted`);
  console.log(`assessor analytics refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${rows[0].assessors} assessors, ${rows[0].records} record-assessor pairs`);
} finally {
  await client.end();
}
