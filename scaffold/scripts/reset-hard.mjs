#!/usr/bin/env node
/**
 * reset-hard.mjs - the only script in this repo that actually empties the database.
 *
 * WHY IT HAD TO EXIST. `reset:clean` is named for something it does not do. Every step in that
 * chain is idempotent by design and nothing in it removes anything:
 *
 *   - `migrate --to 0146` means "stop AFTER 0146". Migrations only run forward, so against a
 *     schema already at 0155 it reports "nothing to apply" and changes nothing at all.
 *   - `seed:program` refuses a published template version - correctly, because overwriting a
 *     published form is how an assessment silently changes shape under signed records.
 *   - `seed:history` counts the sessions already present and writes none.
 *
 * Run against a populated database, `reset:clean` therefore succeeds, prints forty-eight refusals
 * and a row of zeroes, and leaves the instance exactly as it was. On 2026-09-19 that cost a reseed
 * whose three reasons - a raised `strict_bias`, the EBT competency rotation and forty-eight template
 * versions missing `framework_id` - all silently failed to land. The demo-day plan says "reset in the
 * morning"; that reset would have done nothing and nobody would have been told.
 *
 * WHAT THIS DOES. Drops the public schema and rebuilds from migration 0001 through the documented
 * seed chain, which is the same path a new host runs. The database is never copied anywhere and the
 * data is synthetic, so a clean slate is always reachable from this repository alone.
 *
 * THE GUARD. It refuses unless `--drop-database <name>` matches the database DATABASE_URL is
 * actually pointing at. Naming the target is the confirmation: a stale .env, a shell that still has
 * a production URL exported, or a copy-pasted command from another project all fail closed instead
 * of emptying the wrong instance. There is no --force and no prompt-free default.
 *
 * Usage:
 *   node scripts/reset-hard.mjs --drop-database ava_demo
 *   node scripts/reset-hard.mjs --drop-database ava_demo --dry-run
 *
 * Afterwards: `npm run seed:history` for the three years of training history, then `npm run verify`.
 */

import { spawnSync } from 'node:child_process';
import { argValue, connect } from './lib/kit-seed.mjs';

// THE ORDER IS LOAD-BEARING, and the odd-looking first step is the point: migration 0147 READS
// analytics_config (it builds the assessor materialisation from the configured shrink constant), so
// the configuration must be in the table before the migration run reaches it. `--to 0146` stops the
// first pass one migration short of that; config:load fills the table; the second `migrate` carries
// on to the head. Collapse these three into one `migrate` and 0147 fails on an empty config and
// rolls back every migration after it - which is what this script did on its first run, leaving the
// assessor matview and its refresh function undefined and the gate reporting ten unapplied files.
const CHAIN = [
  ['migrate', ['--', '--to', '0146']],
  ['config:load', []],
  ['migrate', []],
  ['seed:framework', []],
  ['seed:operator', []],
  ['seed:library', []],
  ['seed:program', []],
  ['publish:programs', []],
  ['seed:roster', []],
];

// The one account the rebuild needs, created the same way reset:clean creates it. Its password
// is set afterwards, interactively, by `npm run password -- admin_av`: this script never takes
// one on a command line, where it would land in the shell history and the npm log.
const ACCOUNT = ['scripts/create-user.mjs', 'admin_av', 'operator_admin'];

async function main() {
  const named = argValue('--drop-database', null);
  const dryRun = process.argv.includes('--dry-run');

  if (!named) {
    console.error('reset-hard.mjs refuses to run without --drop-database <name>.');
    console.error('Naming the database IS the confirmation: this script empties it.');
    return 2;
  }

  const client = await connect();
  let actual;
  try {
    ({ rows: [{ db: actual }] } = await client.query('SELECT current_database() AS db'));
    if (actual !== named) {
      console.error(`refusing: DATABASE_URL points at "${actual}", you named "${named}".`);
      console.error('Check .env before retrying. Nothing has been changed.');
      return 2;
    }

    const { rows: [counts] } = await client.query(`
      SELECT (SELECT count(*) FROM information_schema.tables
               WHERE table_schema = 'public' AND table_type = 'BASE TABLE')::int AS tables,
             (SELECT count(*) FROM pg_views WHERE schemaname = 'public')::int AS views`);
    console.log(`\nDATABASE "${actual}": ${counts.tables} tables, ${counts.views} views.`);

    if (dryRun) {
      console.log('--dry-run: the schema would be dropped and rebuilt. Nothing changed.');
      return 0;
    }

    console.log('dropping schema public ...');
    // CASCADE takes the views, functions and types with it. The extensions live in their own
    // schema or are recreated by migration 0001, which is why this is re-runnable.
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    console.log('schema public recreated, empty.\n');
  } finally {
    await client.end();
  }

  for (const [script, args] of CHAIN) {
    console.log(`--- npm run ${script} ---`);
    const r = spawnSync('npm', ['run', script, ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) {
      console.error(`\n"npm run ${script}" exited ${r.status}. The rebuild stopped here and the`);
      console.error('database is PART-BUILT: fix the cause and run this script again from the top.');
      return 1;
    }
  }

  console.log('--- create admin_av ---');
  const acc = spawnSync('node', ['--env-file-if-exists=.env', ...ACCOUNT],
    { stdio: 'inherit', shell: process.platform === 'win32' });
  if (acc.status !== 0) {
    console.error(`\ncreate-user exited ${acc.status}. The schema and reference data are in place;`);
    console.error('create the account by hand before seeding history.');
    return 1;
  }

  console.log('\nSchema and reference data rebuilt from migration 0001.');
  console.log('Next: npm run password -- admin_av   (an account, then the history)');
  console.log('      npm run seed:history           (three years of records; several minutes)');
  console.log('      npm run verify                 (the gate, on an environment nothing predates)');
  return 0;
}

main()
  .then((code) => { process.exit(code); })
  .catch((err) => {
    console.error(`\nreset-hard.mjs failed: ${err.message}`);
    console.error('If the schema was already dropped, run this script again; it is re-runnable.');
    process.exit(1);
  });
