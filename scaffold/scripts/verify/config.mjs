/**
 * verify/config.mjs - is the configuration this release reads actually loaded?
 *
 * Contract rule 7 puts every threshold, band boundary and weight in scaffold/config/*.yaml, and
 * the SQL readers of migration 0100 RAISE on a missing key rather than defaulting. That makes a
 * missing key a run-time exception on a chart rather than a wrong number, which is the right
 * failure - but it is still a failure in front of a user. This group moves it to the gate.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCAFFOLD_ROOT, readYamlFile } from '../lib/kit-seed.mjs';

/** Which analytics_config column a reader requires to be populated. */
const READER_COLUMN = {
  number: 'value_num', int: 'value_num', num: 'value_num',
  text: 'value_text', json: 'value_json', require: null,
};

/**
 * Every analytics_config key named by a reader, with the site that named it. Scanned from the
 * source rather than listed here for the same reason the loader scans it: a list of required keys
 * kept by hand is a list to forget to update.
 */
async function requiredKeys() {
  const found = new Map();
  const note = (key, reader, site) => {
    if (!found.has(key)) found.set(key, { readers: new Set(), sites: [] });
    found.get(key).readers.add(reader);
    found.get(key).sites.push(site);
  };
  const scan = async (dir, ext, re, fixedReader) => {
    let names;
    try {
      names = (await readdir(dir, { withFileTypes: true }));
    } catch {
      return;
    }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await scan(full, ext, re, fixedReader); continue; }
      if (!entry.name.endsWith(ext)) continue;
      const lines = (await readFile(full, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(re)) {
          note(m[2], fixedReader ?? m[1], `${path.relative(SCAFFOLD_ROOT, full)}:${i + 1}`);
        }
      });
    }
  };
  await scan(path.join(SCAFFOLD_ROOT, 'db', 'migrations'), '.sql',
    /analytics_(number|int|text|json|require)\('([^']+)'\)/g);
  await scan(path.join(SCAFFOLD_ROOT, 'scripts'), '.mjs',
    /\banalytics\.(num|int|text|json)\('([^']+)'\)/g);
  return found;
}

export const checks = [
  {
    name: 'every analytics_config key a reader names is loaded',
    async run({ client }) {
      const required = await requiredKeys();
      const { rows } = await client.query(
        'SELECT key, value_num, value_text, value_json FROM analytics_config',
      );
      const byKey = new Map(rows.map((r) => [r.key, r]));
      const problems = [];
      for (const [key, req] of required) {
        const row = byKey.get(key);
        if (!row) { problems.push(`${key} absent (read by ${req.sites[0]})`); continue; }
        for (const reader of req.readers) {
          const column = READER_COLUMN[reader];
          if (!column) continue;
          if (row[column] === null || row[column] === undefined) {
            problems.push(`${key} holds no ${column} (read by ${req.sites[0]})`);
          }
        }
      }
      return {
        ok: required.size > 0 && problems.length === 0,
        detail: required.size === 0
          ? 'no reader names any key, which cannot be right'
          : problems.length === 0
            ? `${required.size} keys required by SQL and scripts, ${rows.length} loaded`
            : problems.slice(0, 3).join('; ') + (problems.length > 3 ? ` (+${problems.length - 3})` : ''),
      };
    },
  },
  {
    name: 'analytics_config carries exactly one config version',
    async run({ client }) {
      const { rows } = await client.query(
        'SELECT DISTINCT config_version FROM analytics_config ORDER BY 1',
      );
      return {
        ok: rows.length === 1,
        detail: rows.length === 1
          ? `version ${rows[0].config_version}`
          : `${rows.length} versions present: ${rows.map((r) => r.config_version).join(', ')} - a half-loaded config`,
      };
    },
  },
  {
    name: 'the loaded analytics version is the file on disk, and is active',
    async run({ client }) {
      const file = await readYamlFile('config/analytics.yaml');
      const { rows } = await client.query(
        `SELECT version, checksum, is_active FROM config_versions
          WHERE name = 'analytics' AND is_active ORDER BY loaded_at DESC LIMIT 1`,
      );
      const { rows: loaded } = await client.query(
        'SELECT DISTINCT config_version FROM analytics_config',
      );
      if (rows.length === 0) {
        return { ok: false, detail: 'no active config_versions row named analytics; run scripts/load-analytics-config.mjs' };
      }
      const versionMatches = rows[0].version === String(file.data.version);
      const checksumMatches = rows[0].checksum === file.checksum;
      const tableMatches = loaded.length === 1 && loaded[0].config_version === rows[0].version;
      return {
        ok: versionMatches && checksumMatches && tableMatches,
        detail: versionMatches && checksumMatches && tableMatches
          ? `analytics ${rows[0].version}, checksum ${rows[0].checksum.slice(0, 12)}`
          : `recorded ${rows[0].version}/${rows[0].checksum.slice(0, 12)} vs file `
            + `${file.data.version}/${file.checksum.slice(0, 12)}; analytics_config at `
            + `${loaded.map((r) => r.config_version).join(',') || '(empty)'}`,
      };
    },
  },
  {
    name: 'the recorded policy version is the file on disk, and is active',
    async run({ client, policyFile }) {
      const { rows } = await client.query(
        `SELECT version, checksum FROM config_versions
          WHERE name = 'policy' AND is_active ORDER BY loaded_at DESC LIMIT 1`,
      );
      if (rows.length === 0) {
        return {
          ok: false,
          detail: 'no active config_versions row named policy; the seed records it, so this '
            + 'environment was not built by the documented path',
        };
      }
      const ok = rows[0].version === String(policyFile.data.version)
        && rows[0].checksum === policyFile.checksum;
      return {
        ok,
        detail: ok
          ? `policy ${rows[0].version}, checksum ${rows[0].checksum.slice(0, 12)}`
          : `recorded ${rows[0].version}/${rows[0].checksum.slice(0, 12)} vs file `
            + `${policyFile.data.version}/${policyFile.checksum.slice(0, 12)}`,
      };
    },
  },
];
