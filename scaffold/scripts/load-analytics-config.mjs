#!/usr/bin/env node
/**
 * load-analytics-config.mjs - fills the analytics_config table from scaffold/config/analytics.yaml.
 *
 * WHY THIS SCRIPT EXISTS. Contract rule 7: no threshold, band boundary or weight may be inline in
 * code - and SQL is code. Migration 0100 therefore creates analytics_config plus the readers
 * analytics_number / analytics_int / analytics_text / analytics_json, and every av_* view reads its
 * constants through them. Those readers RAISE on a missing key rather than defaulting, because a
 * default in SQL is a hardcoded threshold wearing a disguise. This script is what makes them
 * answer, and until it has run the analytics layer is deliberately inoperable.
 *
 * ORDER. After scripts/migrate.mjs (the table must exist), before anything that reads a threshold:
 * the seeds, the views, the app. scripts/reset-to-seed.mjs runs it in exactly that position and
 * refuses to continue without it.
 *
 * WHAT IT WRITES
 *
 *   1. One row per LEAF of analytics.yaml, keyed by its dotted path
 *      (`grade_scale.below_standard_max`, `program_indicator.target.value`).
 *   2. One row per CONTAINER as well - every object and every array - carrying its whole subtree in
 *      value_json under its own path, so a view that needs `program_indicator.scopes`,
 *      `program_indicator.alert_sigma`, `screening_index.points` or `grade_scale.non_scoring`
 *      whole reads it in one call instead of reassembling leaves. Every container is stored rather
 *      than a hand-maintained list of them, because a hand-maintained list is a thing to forget.
 *   3. A row in config_versions (name `analytics`), checksummed and activated, so every figure the
 *      platform stores can name the configuration it was computed under.
 *
 * IDEMPOTENT. Re-running loads the same rows: leaves upsert on `key`, and a key that has left the
 * YAML is DELETED rather than left behind. A retired threshold that lingers in the table is worse
 * than a missing one, because a view can still read it and nobody will notice it is stale.
 *
 * FAILS LOUDLY. Before it writes anything it scans db/migrations/*.sql and scripts/*.mjs for every
 * analytics_config key their readers name, and refuses to load a file that does not carry one of
 * them - with the file and line that asked for it. That check is the whole point of the script: the
 * alternative is discovering the gap when a chart raises `no_data_found` in front of an auditor.
 *
 * Usage:
 *   node scripts/load-analytics-config.mjs
 *   node scripts/load-analytics-config.mjs --dry-run     validate and print, no database needed
 *   node scripts/load-analytics-config.mjs --verbose     print every key
 *   node scripts/load-analytics-config.mjs --help
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SCAFFOLD_ROOT, argFlag, connect, loadPolicy, readYamlFile, recordConfigVersion, renderTable,
} from './lib/kit-seed.mjs';

const CONFIG_FILE = 'config/analytics.yaml';
const DRY_RUN = argFlag('--dry-run');
const VERBOSE = argFlag('--verbose');

const HELP = `
load-analytics-config.mjs - loads ${CONFIG_FILE} into the analytics_config table.

  --dry-run    parse, flatten and run the required-key check; write nothing, connect to nothing
  --verbose    print every key that would be written
  --help       this text

Run it AFTER scripts/migrate.mjs and BEFORE any script, view or page that reads a threshold.
`;

class ConfigLoadError extends Error {}

/* ========================================================================= *
 * 1. Flattening
 * ========================================================================= */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Walks the parsed YAML and produces one row per node.
 *
 * Scalars carry their typed column AND value_json, so `analytics_json('a.b')` works on a leaf as
 * well as on a container. Containers carry value_json only: asking `analytics_number()` for an
 * object must raise, and it does.
 *
 * Booleans are stored as value_text 'true' / 'false' plus value_json, and NOT as 1 / 0. A boolean
 * coerced to a number is a boolean that can be summed, averaged and compared to a threshold, and
 * one of those three will eventually happen by accident.
 */
function flatten(node, prefix, rows) {
  const push = (key, num, text, json) => rows.push({ key, num, text, json });

  if (isPlainObject(node) || Array.isArray(node)) {
    if (prefix) push(prefix, null, null, node);
    const entries = Array.isArray(node)
      ? node.map((v, i) => [String(i), v])
      : Object.entries(node);
    for (const [k, v] of entries) {
      flatten(v, prefix ? `${prefix}.${k}` : k, rows);
    }
    return rows;
  }

  if (typeof node === 'number') push(prefix, node, null, node);
  else if (typeof node === 'boolean') push(prefix, null, String(node), node);
  else if (node === null || node === undefined) push(prefix, null, null, null);
  else push(prefix, null, String(node), String(node));
  return rows;
}

/* ========================================================================= *
 * 2. The required-key check
 * ========================================================================= */

/** Which reader was used, and therefore which column must be populated. */
const READER_COLUMN = {
  number: 'num', int: 'num', text: 'text', json: 'json', require: 'any',
};

/**
 * Every analytics_config key named by a SQL reader in db/migrations, and by the seed scripts'
 * accessor in scripts/. Returned with the file and line that named it, so a failure points at the
 * caller rather than at the config.
 */
async function requiredKeys() {
  const found = new Map(); // key -> { readers:Set, sites:[] }
  const note = (key, reader, site) => {
    if (!found.has(key)) found.set(key, { readers: new Set(), sites: [] });
    const entry = found.get(key);
    entry.readers.add(reader);
    entry.sites.push(site);
  };

  const scan = async (dir, filter, patterns) => {
    let names;
    try {
      names = (await readdir(dir)).filter(filter).sort();
    } catch {
      return; // a directory that is not there names no keys
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const text = await readFile(full, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const { re, reader } of patterns) {
          for (const m of line.matchAll(re)) {
            note(m[2], reader ?? m[1], `${path.basename(dir)}/${name}:${i + 1}`);
          }
        }
      });
    }
  };

  await scan(
    path.join(SCAFFOLD_ROOT, 'db', 'migrations'),
    (n) => n.endsWith('.sql'),
    [{ re: /analytics_(number|int|text|json|require)\('([^']+)'\)/g }],
  );
  await scan(
    path.join(SCAFFOLD_ROOT, 'scripts'),
    (n) => n.endsWith('.mjs'),
    [{ re: /\banalytics\.(num|int|text|json)\('([^']+)'\)/g }],
  );

  // The accessor names differ between the two layers; normalise to the SQL reader vocabulary.
  const normalise = (r) => (r === 'num' ? 'number' : r);
  return [...found.entries()].map(([key, v]) => ({
    key,
    readers: [...v.readers].map(normalise),
    sites: v.sites,
  })).sort((a, b) => a.key.localeCompare(b.key));
}

function checkRequired(rows, required) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const problems = [];
  for (const req of required) {
    const row = byKey.get(req.key);
    if (!row) {
      problems.push(
        `${CONFIG_FILE} has no key "${req.key}", which is read by ${req.sites.join(', ')}. ` +
          'Add it to the YAML. Do not add a default to the reader: a default in SQL or in a ' +
          'script is a hardcoded threshold.',
      );
      continue;
    }
    for (const reader of req.readers) {
      const column = READER_COLUMN[reader];
      if (column === 'any') continue;
      const value = column === 'num' ? row.num : column === 'text' ? row.text : row.json;
      if (value === null || value === undefined) {
        problems.push(
          `"${req.key}" is read with analytics_${reader}() by ${req.sites.join(', ')}, but its ` +
            `value in ${CONFIG_FILE} carries no ${column === 'num' ? 'numeric' : column} value. ` +
            'The reader will raise at query time; fix the type in the YAML.',
        );
      }
    }
  }
  return problems;
}

/* ========================================================================= *
 * 3. Writing
 * ========================================================================= */

async function write(client, rows, file) {
  const version = String(file.data.version ?? '');
  if (!version) throw new ConfigLoadError(`${CONFIG_FILE} has no version key`);

  await client.query('BEGIN');
  try {
    for (const row of rows) {
      await client.query(
        `INSERT INTO analytics_config (key, value_num, value_text, value_json, config_version, loaded_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, now())
         ON CONFLICT (key) DO UPDATE
           SET value_num      = EXCLUDED.value_num,
               value_text     = EXCLUDED.value_text,
               value_json     = EXCLUDED.value_json,
               config_version = EXCLUDED.config_version,
               loaded_at      = now()`,
        [row.key, row.num, row.text, JSON.stringify(row.json ?? null), version],
      );
    }

    // A key that has left the YAML leaves the table with it. Otherwise a retired threshold stays
    // readable, a view keeps returning a number nobody chose, and nothing anywhere says so.
    const { rows: removed } = await client.query(
      'DELETE FROM analytics_config WHERE NOT (key = ANY($1::text[])) RETURNING key',
      [rows.map((r) => r.key)],
    );

    const configVersionId = await recordConfigVersion(client, {
      name: 'analytics',
      version,
      checksum: file.checksum,
      payload: file.data,
      notes: file.data.note ?? 'Loaded by scripts/load-analytics-config.mjs.',
    });

    // policy.yaml is recorded HERE as well, not only by the synthetic seeder: an instance stood up
    // without a synthetic population (reset:clean) must still pass the config gate's
    // "recorded policy version is the file on disk" assertion, and the policy is configuration
    // exactly like the thresholds are.
    const policyFile = await loadPolicy();
    await recordConfigVersion(client, {
      name: 'policy',
      version: String(policyFile.data.version),
      checksum: policyFile.checksum,
      payload: policyFile.data,
      notes: policyFile.data.note ?? 'Loaded by scripts/load-analytics-config.mjs.',
    });

    await client.query('COMMIT');
    return { version, configVersionId, removed: removed.map((r) => r.key) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/* ========================================================================= *
 * 4. Main
 * ========================================================================= */

async function main() {
  if (argFlag('--help')) { console.log(HELP); return; }

  const file = await readYamlFile(CONFIG_FILE);
  const rows = flatten(file.data, '', []);
  const leaves = rows.filter((r) => r.json === null || typeof r.json !== 'object');
  const containers = rows.length - leaves.length;

  const required = await requiredKeys();
  const problems = checkRequired(rows, required);
  if (problems.length > 0) {
    console.error(`\n${CONFIG_FILE} is missing keys its readers require:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    throw new ConfigLoadError(
      `${problems.length} required analytics_config key(s) unsatisfied. Nothing was written.`,
    );
  }

  console.log(
    `${CONFIG_FILE} version ${file.data.version} checksum ${file.checksum}\n` +
      `  ${rows.length} rows (${leaves.length} leaves, ${containers} containers)\n` +
      `  ${required.length} keys required by db/migrations and scripts: all present\n`,
  );

  if (VERBOSE) {
    console.log(renderTable(
      ['key', 'num', 'text', 'json'],
      rows.map((r) => [
        r.key,
        r.num ?? '',
        r.text ?? '',
        typeof r.json === 'object' && r.json !== null ? '(subtree)' : '',
      ]),
    ));
  }

  if (DRY_RUN) {
    console.log('--dry-run: nothing written, no connection opened.');
    return;
  }

  const client = await connect();
  let result;
  try {
    result = await write(client, rows, file);
  } finally {
    await client.end();
  }

  console.log(`analytics_config loaded at version ${result.version}`);
  console.log(`config_versions row ${result.configVersionId} is now the active analytics config`);
  if (result.removed.length > 0) {
    console.log(`removed ${result.removed.length} key(s) no longer in the YAML:`);
    for (const key of result.removed) console.log(`  - ${key}`);
  }
  console.log('\nNext: node scripts/seed-framework.mjs');
}

main().catch((err) => {
  if (err instanceof ConfigLoadError) console.error(`\nanalytics config load REFUSED: ${err.message}\n`);
  else console.error(err);
  process.exit(1);
});
