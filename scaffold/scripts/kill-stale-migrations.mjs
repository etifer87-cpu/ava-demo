#!/usr/bin/env node
/**
 * kill-stale-migrations.mjs - cancel abandoned migration backends.
 *
 *   node --env-file=.env scripts/kill-stale-migrations.mjs            0147 by default
 *   node --env-file=.env scripts/kill-stale-migrations.mjs 0148
 *
 * Ctrl-C stops the node process but does not always cancel the query it started: Postgres keeps
 * running it until it next tries to write to a closed socket, which a long build may not do for a
 * long time. The abandoned transaction keeps its locks, so the next attempt queues behind it and
 * looks slow when it is only waiting. This asks those backends to cancel, then terminates whatever
 * ignored the cancel. Each one is inside a transaction that rolls back, so nothing is half-applied.
 */
import { connect } from './lib/kit-seed.mjs';

const tag = process.argv[2] ?? '0147';
const client = await connect();
try {
  const { rows: before } = await client.query(
    `SELECT pid, state, wait_event, date_trunc('second', now() - query_start)::text AS running_for
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND query LIKE '%' || $1 || '%' AND state <> 'idle'
      ORDER BY query_start`, [tag]);
  if (before.length === 0) { console.log(`nothing running that mentions ${tag}; the queue is clear`); }
  else {
    console.log(`${before.length} backend(s) running ${tag}:`);
    for (const r of before) console.log(`  pid ${r.pid}  ${r.state}  waiting on ${r.wait_event ?? '-'}  for ${r.running_for}`);
    for (const r of before) await client.query(`SELECT pg_cancel_backend($1)`, [r.pid]);
    await new Promise((r) => setTimeout(r, 3000));
    for (const r of before) {
      const { rows } = await client.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state <> 'idle'`, [r.pid]);
      if (rows.length) { await client.query(`SELECT pg_terminate_backend($1)`, [r.pid]); console.log(`  pid ${r.pid} ignored the cancel; terminated`); }
      else console.log(`  pid ${r.pid} cancelled`);
    }
  }
  const { rows: after } = await client.query(
    `SELECT count(*)::int AS still_running FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND query LIKE '%' || $1 || '%' AND state <> 'idle'`, [tag]);
  console.log(`still running: ${after[0].still_running}`);
} finally {
  await client.end();
}
