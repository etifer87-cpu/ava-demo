#!/usr/bin/env node
/**
 * diag-progress.mjs - what is the database actually doing right now?
 *
 * Run in a second window while a migration or seed is in flight. Read-only: it prints the running
 * backends with their elapsed time, state and wait event, the first line of each query, which
 * mv_assessor_* views already exist, and the row counts of the base tables the build reads - enough
 * to tell a slow stage from a stuck lock without touching anything.
 */
import { connect } from './lib/kit-seed.mjs';

const client = await connect();
const show = async (label, sql) => {
  try { const { rows } = await client.query(sql); console.log(`\n== ${label}`); console.table(rows); }
  catch (e) { console.log(`\n== ${label}\n  ERROR ${e.message}`); }
};
try {
  await show('running backends (longest first)', `
    SELECT pid, state, wait_event_type, wait_event,
           date_trunc('second', now() - query_start)::text AS running_for,
           left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS query
      FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
     ORDER BY query_start`);
  await show('locks waiting on something', `
    SELECT pid, locktype, relation::regclass::text AS relation, mode, granted
      FROM pg_locks WHERE NOT granted`);
  await show('materialised views that exist so far', `
    SELECT c.relname, c.relispopulated AS populated, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'm' AND n.nspname = 'public' ORDER BY c.relname`);
  await show('what the build has to chew through', `
    SELECT (SELECT count(*) FROM records WHERE deleted_at IS NULL) AS records,
           (SELECT count(*) FROM record_competencies) AS record_competencies,
           (SELECT count(*) FROM competency_grades) AS competency_grades,
           (SELECT count(*) FROM element_grades) AS element_grades,
           (SELECT count(*) FROM record_tasks) AS record_tasks,
           (SELECT count(*) FROM sessions WHERE deleted_at IS NULL) AS sessions`);
} finally {
  await client.end();
}
