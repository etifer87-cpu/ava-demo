#!/usr/bin/env node
/**
 * reset-to-seed.mjs - the one command that takes an empty database to a renderable install.
 *
 * THE ORDER IS THE POINT.
 *
 *   1. migrate                    schema, functions, views
 *   2. load the analytics config  thresholds into analytics_config
 *   3. seed the framework         9 competencies, 73 observable behaviours
 *   4. seed the templates         four starter forms, published as version 1
 *   5. seed the synthetic data    roster, sessions, grades, records, sectors, analysis runs
 *   6. verify                     the gate suite: schema, config, framework, templates, data,
 *                                 analytics and access, one named assertion each
 *
 * Step 6 runs HERE, at the end of a reset, because that is the one moment it is a gate rather
 * than a monitor: the environment has just taken new code and has just been reseeded, and nothing
 * in it is older than this run. See the header of scripts/verify.mjs.
 *
 * Step 2 sits where it does for one reason. Every threshold, band boundary and weight in the
 * platform lives in scaffold/config/analytics.yaml and is read at runtime from analytics_config.
 * It cannot be loaded before the migration that creates that table, and nothing that reads a
 * threshold may run before it is filled. Get this order wrong and nothing fails: grade_num()
 * raises on a missing key in SQL, but a script that quietly substituted a default would produce a
 * population shaped to the wrong boundaries, every band assertion would pass against those wrong
 * boundaries, and the install would look perfect and be wrong. So the readers raise instead of
 * defaulting, and this script checks the table is non-empty before going on.
 *
 * This script does NOT drop anything. Deletion is soft everywhere in this platform and enforced by
 * trigger, so there is no honest in-place reset: a true reset is a new database. See --help.
 *
 * Usage:
 *   node scripts/reset-to-seed.mjs
 *   node scripts/reset-to-seed.mjs --seed demo-2 --subjects 60 --months 36 --as-of 2026-08-26
 *   node scripts/reset-to-seed.mjs --dry-run
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argFlag, argValue, connect } from './lib/kit-seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = argFlag('--dry-run');

const HELP = `
reset-to-seed.mjs - migrate, load config, seed framework, seed templates, seed synthetic data,
                    then run the gate suite.

  --seed <text>        synthetic population seed        (default: policy.yaml synthetic.default_seed)
  --subjects <n>       synthetic subjects               (default: policy.yaml synthetic.default_subjects)
  --months <n>         minimum window in months         (default: policy.yaml synthetic.default_months)
  --as-of <date>       end of the window, ISO           (default: today)
  --dry-run            print the ordered plan and exit
  --help               this text

A true reset is a NEW DATABASE. Nothing in this platform hard-deletes: people, sessions and records
carry a trigger that refuses DELETE, and every soft delete is audited. To start clean:

  dropdb <name> && createdb <name>       # or the equivalent in your deployment
  DATABASE_URL=... node scripts/reset-to-seed.mjs
`;

/** Pass-through arguments for the synthetic generator only. */
function synthArgs() {
  const out = [];
  for (const name of ['--seed', '--subjects', '--months', '--as-of']) {
    const value = argValue(name, undefined);
    if (value !== undefined) out.push(name, value);
  }
  return out;
}

const STEPS = [
  { key: 'migrate', script: 'migrate.mjs', args: [],
    why: 'schema, functions and views; forward-only, one transaction per file' },
  { key: 'config', script: 'load-analytics-config.mjs', args: [], external: true,
    why: 'thresholds into analytics_config; AFTER migrate, BEFORE anything that reads one' },
  { key: 'framework', script: 'seed-framework.mjs', args: [],
    why: '9 competencies and 73 observable behaviours, asserted against docs/03' },
  { key: 'templates', script: 'seed-templates.mjs', args: [],
    why: 'four starter templates, published as version 1 under the builder publish rules' },
  { key: 'synthetic', script: 'seed-synthetic.mjs', args: synthArgs(),
    why: 'roster, sessions, grades, records, sectors and analysis runs; asserts band coverage' },
  { key: 'verify', script: 'verify.mjs', args: [],
    why: 'the gate suite of docs/15 section 9, run here because a freshly reseeded environment '
       + 'is the only environment it is a gate for' },
];

function run(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, step.script), ...step.args], {
      stdio: 'inherit', env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0
      ? resolve()
      : reject(new Error(`${step.script} exited with code ${code}`))));
  });
}

async function assertConfigLoaded() {
  const client = await connect();
  try {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM analytics_config');
    if (rows[0].n === 0) {
      throw new Error(
        'analytics_config is empty after the config step. Everything downstream reads its ' +
          'thresholds from this table and will refuse to run, which is the correct behaviour: a ' +
          'seed built against defaults nobody chose is worse than no seed at all.',
      );
    }
    const { rows: version } = await client.query(
      'SELECT DISTINCT config_version FROM analytics_config',
    );
    console.log(`\n  analytics_config: ${rows[0].n} keys at version ${version.map((v) => v.config_version).join(', ')}\n`);
  } finally {
    await client.end();
  }
}

async function main() {
  if (argFlag('--help')) { console.log(HELP); return; }

  if (DRY_RUN) {
    console.log('reset-to-seed would run, in this order:\n');
    STEPS.forEach((step, i) => {
      console.log(`  ${i + 1}. ${step.script} ${step.args.join(' ')}`);
      console.log(`     ${step.why}`);
    });
    console.log('\nNothing was run.');
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. See .env.example; values are never committed.');
    process.exit(2);
  }

  // The config loader belongs to the analytics layer (migration 0100 names it). If it is absent,
  // stop here rather than seeding a database whose thresholds nobody loaded.
  for (const step of STEPS) {
    try {
      await access(path.join(HERE, step.script));
    } catch {
      console.error(
        `\nscripts/${step.script} is missing.\n\n` +
        (step.external
          ? '  This script is owned by the analytics layer and is named by migration\n' +
            '  0100_analytics_config.sql. It must flatten every leaf key of\n' +
            '  scaffold/config/analytics.yaml to a dotted path in analytics_config, additionally\n' +
            '  store each container a view reads whole (program_indicator.scopes,\n' +
            '  program_indicator.alert_sigma, screening_index.points, grade_scale.non_scoring) as\n' +
            '  value_json under its own path, and record the version in config_versions.\n\n' +
            '  Nothing downstream can run without it, and none of the seed scripts will substitute\n' +
            '  a default for a threshold.\n'
          : '  This is part of the seed layer and should be beside this file.\n'),
      );
      process.exit(1);
    }
  }

  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];
    console.log(`\n=== ${i + 1}/${STEPS.length}  ${step.script} ${step.args.join(' ')}`);
    console.log(`    ${step.why}\n`);
    await run(step);
    if (step.key === 'config') await assertConfigLoaded();
  }

  console.log('\nDone. The database is migrated, configured, seeded, renderable and gated.');
}

main().catch((err) => {
  console.error(`\nreset-to-seed FAILED: ${err.message}\n`);
  console.error('Nothing later in the order ran. Fix the failing step and run again; every step is ' +
    'idempotent except the synthetic generator, which refuses to run twice into the same database.');
  process.exit(1);
});
