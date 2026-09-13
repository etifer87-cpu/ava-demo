#!/usr/bin/env node
/** diag-0147.mjs - why does 0147 not see analytics_number()? Read-only; prints and exits. */
import { connect } from './lib/kit-seed.mjs';

const client = await connect();
const show = async (label, sql) => {
  try { const { rows } = await client.query(sql); console.log(`\n== ${label}\n`, JSON.stringify(rows, null, 1)); }
  catch (e) { console.log(`\n== ${label}\n  ERROR ${e.message}`); }
};
try {
  await show('who / where', `SELECT current_user, current_database(), current_setting('search_path') AS search_path, version()`);
  await show('analytics_* functions', `SELECT n.nspname AS schema, p.proname, pg_get_function_identity_arguments(p.oid) AS args, l.lanname AS lang FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang WHERE p.proname LIKE 'analytics_%' ORDER BY 1, 2`);
  await show('call analytics_number', `SELECT analytics_number('assessor_fairness.adjusted_delta.k_shrink') AS k_shrink`);
  await show('call analytics_int', `SELECT analytics_int('assessor_fairness.expected.window_rank') AS window_rank`);
  await show('config rows present', `SELECT key, value_num FROM analytics_config WHERE key LIKE 'assessor_fairness.%' ORDER BY key`);
  await client.query(`SET statement_timeout = 0`);
  await show('one row of av_assessor_occurrence', `SELECT * FROM av_assessor_occurrence LIMIT 1`);
  await show('one row of av_assessor_expected (may be slow)', `SELECT * FROM av_assessor_expected LIMIT 1`);
  await show('in a transaction with SET LOCAL search_path', `BEGIN; SET LOCAL search_path TO public, pg_catalog; SELECT analytics_number('assessor_fairness.adjusted_delta.k_shrink') AS k; COMMIT;`);
} finally {
  await client.end();
}
