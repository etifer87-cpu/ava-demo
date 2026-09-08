#!/usr/bin/env node
/**
 * verify.mjs - THE GATE SUITE. Specified by docs/15_DEPLOYMENT.md section 9.
 *
 * WHAT THIS IS. An assertion suite run against a FRESHLY MIGRATED, FRESHLY SEEDED environment,
 * as step 9 of the deploy, before any traffic reaches it. It is the last thing that runs between
 * "the code and the schema landed" and "people are using it".
 *
 * WHAT THIS IS NOT. It is not a monitor. A monitor watches an environment that has been live for
 * a week and therefore tests the traffic rather than the release; by the time it reports, the bad
 * release is already the thing producing the data. The four rules below are what keep the
 * distinction, and none of them is negotiable:
 *
 *   1. IT RUNS AGAINST A FRESHLY MIGRATED AND RESEEDED ENVIRONMENT. Every assertion here assumes
 *      the database was built by the documented path - migrate, config:load, seed:framework,
 *      seed:templates, seed:synthetic - and holds nothing older than that. Run it later and it is
 *      measuring accumulated traffic, which is a different question with a different answer.
 *   2. IT EXITS NON-ZERO ON ANY FAILURE, and the deploy stops. A suite whose failures are read
 *      afterwards is a monitor, and a monitor does not stop a bad release.
 *   3. THERE IS NO "THIS DATA PREDATES THE CHECK" ESCAPE, AND THERE NEVER MAY BE. No assertion in
 *      this file takes a cutoff date, a created_at floor, a legacy flag, an ignore list or an
 *      environment variable that narrows it. The moment one check can be waived for old rows,
 *      every later violation is indistinguishable from an old one and the check has stopped
 *      meaning anything at all. If a new invariant does not hold for the data that exists, the
 *      release carries the migration that makes it hold, or the invariant is not adopted. Data is
 *      fixed forward; checks are never narrowed to fit the data. A future author who needs an
 *      exemption to make this suite pass has found a defect, not an exemption.
 *   4. IT IS DETERMINISTIC AND OFFLINE. No model call, no network, no clock-dependent assertion.
 *      The same database must produce the same verdict on a restored dump as on the live host,
 *      which is what makes this suite usable in the restore drill of docs/15 section 6.
 *
 * OUTPUT. One row per named assertion - group, assertion, PASS or FAIL, one line of detail - then
 * a summary table per group. Every assertion is named, because "verification failed" is not a
 * result anybody can act on.
 *
 * The assertions themselves live in scripts/verify/*.mjs, one module per group, so that no file
 * here exceeds what a reader can hold. Each module exports `checks`: an array of
 * { name, run(ctx) -> { ok, detail } }. A check that throws is a FAIL carrying the message; it
 * never aborts the run, because the whole point of a suite is the second failure.
 *
 * Usage:
 *   node scripts/verify.mjs
 *   node scripts/verify.mjs --env stage        the label printed in the header; the connection
 *                                              always comes from DATABASE_URL
 *   node scripts/verify.mjs --group analytics  run one group (diagnosis only - a deploy runs all)
 *   node scripts/verify.mjs --help
 */

import { argFlag, argValue, connect, loadPolicy, readAnalyticsConfig, renderTable } from './lib/kit-seed.mjs';
import { checks as schemaChecks } from './verify/schema.mjs';
import { checks as configChecks } from './verify/config.mjs';
import { checks as frameworkChecks } from './verify/framework.mjs';
import { checks as templateChecks } from './verify/templates.mjs';
import { checks as dataChecks } from './verify/data.mjs';
import { checks as analyticsChecks } from './verify/analytics.mjs';
import { checks as accessChecks } from './verify/access.mjs';

const GROUPS = [
  ['schema', schemaChecks],
  ['config', configChecks],
  ['framework', frameworkChecks],
  ['templates', templateChecks],
  ['data', dataChecks],
  ['analytics', analyticsChecks],
  ['access', accessChecks],
];

const HELP = `
verify.mjs - the deploy gate suite (docs/15_DEPLOYMENT.md section 9).

  --env <label>     label for the header line; the connection is always DATABASE_URL
  --group <name>    run one group only: ${GROUPS.map(([g]) => g).join(' ')}
  --help            this text

Run it after migrate, config:load, seed:framework, seed:templates and seed:synthetic, on an
environment that has just taken the release. It exits non-zero on any failure and the deploy stops.
`;

async function main() {
  if (argFlag('--help')) {
    console.log(HELP);
    return 0;
  }

  const envLabel = argValue('--env', process.env.APP_ENV || '(unlabelled)');
  const onlyGroup = argValue('--group', null);
  if (onlyGroup && !GROUPS.some(([g]) => g === onlyGroup)) {
    console.error(`unknown --group "${onlyGroup}". One of: ${GROUPS.map(([g]) => g).join(' ')}`);
    return 2;
  }

  const policyFile = await loadPolicy();
  const client = await connect();
  const results = [];

  try {
    const { rows: dbRows } = await client.query('SELECT current_database() AS db, version() AS v');
    // Read once, and read it from the DATABASE rather than from disk: an environment whose
    // analytics_config has not been loaded must fail here, loudly, and not read the YAML instead.
    const analytics = await readAnalyticsConfig(client);

    console.log(`\nGATE RUN - environment ${envLabel}, database ${dbRows[0].db}`);
    console.log(`${dbRows[0].v.split(',')[0]}`);
    console.log('A gate, not a monitor: run on a freshly migrated and reseeded environment, before traffic.\n');

    const ctx = { client, policy: policyFile.data, policyFile, analytics };

    for (const [group, checks] of GROUPS) {
      if (onlyGroup && group !== onlyGroup) continue;
      for (const check of checks) {
        let outcome;
        try {
          outcome = await check.run(ctx);
        } catch (err) {
          // A check that throws is a failure with a message, never a crashed run: the second
          // failure is usually the one that explains the first.
          outcome = { ok: false, detail: `threw: ${err.message.split('\n')[0]}` };
        }
        results.push({ group, name: check.name, ok: outcome.ok === true, detail: outcome.detail ?? '' });
      }
    }
  } finally {
    await client.end();
  }

  console.log('ASSERTIONS');
  console.log(renderTable(
    ['group', 'assertion', 'result', 'detail'],
    results.map((r) => [r.group, r.name, r.ok ? 'PASS' : 'FAIL', r.detail]),
  ));

  const byGroup = new Map();
  for (const r of results) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, { pass: 0, fail: 0 });
    byGroup.get(r.group)[r.ok ? 'pass' : 'fail'] += 1;
  }
  const failed = results.filter((r) => !r.ok);

  console.log('\nSUMMARY');
  console.log(renderTable(
    ['group', 'assertions', 'passed', 'failed', 'result'],
    [...byGroup.entries()].map(([group, v]) => [
      group, v.pass + v.fail, v.pass, v.fail, v.fail === 0 ? 'PASS' : 'FAIL',
    ]).concat([['total', results.length, results.length - failed.length, failed.length,
      failed.length === 0 ? 'PASS' : 'FAIL']]),
  ));

  if (failed.length > 0) {
    console.error('\nFAILED ASSERTIONS');
    for (const r of failed) console.error(`  ${r.group} / ${r.name}: ${r.detail}`);
    console.error(
      '\nThe gate has failed and the deploy does not proceed. Fix the release or the migration '
      + 'that makes the invariant hold. Do not narrow a check to fit the data: an assertion with '
      + 'an exemption for existing rows can no longer tell a new violation from an old one.',
    );
    return 1;
  }

  console.log('\nAll assertions passed. The environment is gated in.');
  return 0;
}

main()
  .then((code) => { process.exit(code); })
  .catch((err) => {
    console.error(`\nverify.mjs could not run: ${err.message}`);
    console.error('This is a failed gate, not a skipped one.');
    process.exit(2);
  });
