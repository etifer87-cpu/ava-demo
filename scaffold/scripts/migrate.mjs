#!/usr/bin/env node
/**
 * migrate.mjs - the migration runner.
 *
 * Forward-only. There is no `down`. A mistake is corrected by a new numbered file, because a
 * rollback that has already been applied to production data is a data-loss event pretending to be
 * a safety feature.
 *
 * Rules this runner enforces:
 *   - files are `NNNN_name.sql` in scaffold/db/migrations, applied in numeric order;
 *   - each file runs inside ITS OWN transaction, so a failure leaves earlier files applied and
 *     this one wholly unapplied - never half;
 *   - applied files are recorded in schema_migrations with a checksum, and a file whose contents
 *     changed after being applied is a hard error rather than a silent no-op;
 *   - the client's 'notice' event is LISTENED FOR. Without that listener every RAISE NOTICE - which
 *     is how the seed assertions and the FK verifier report - is discarded by the driver, and a
 *     migration that printed a warning appears to have printed nothing.
 *
 * Usage:
 *   node scripts/migrate.mjs              apply everything pending
 *   node scripts/migrate.mjs --dry-run    list what would be applied
 *   node scripts/migrate.mjs --to 0042    stop after this number
 *   node scripts/migrate.mjs --status     show applied and pending, apply nothing
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'db', 'migrations');
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = flag('--dry-run');
const STATUS_ONLY = flag('--status');
const STOP_AFTER = value('--to');

const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    number      INT         NOT NULL,
    checksum    TEXT        NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INT         NOT NULL DEFAULT 0
  );
  COMMENT ON TABLE schema_migrations IS 'One row per applied migration file, with a checksum so an edited-after-apply file fails loudly.';
`;

function checksum(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

async function loadMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.sql')) continue;
    const match = FILE_RE.exec(name);
    if (!match) {
      throw new Error(
        `Migration file "${name}" does not match NNNN_lower_snake_name.sql. ` +
          'Rename it; the runner will not guess an order.',
      );
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    files.push({ name, number: Number(match[1]), sql, checksum: checksum(sql) });
  }
  files.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

  const seen = new Map();
  for (const file of files) {
    if (seen.has(file.number)) {
      throw new Error(
        `Duplicate migration number ${file.number}: "${seen.get(file.number)}" and "${file.name}". ` +
          'Migration ranges are assigned per module; see the kit contract.',
      );
    }
    seen.set(file.number, file.name);
  }
  return files;
}

/**
 * Attaches the notice listener. This is the whole reason RAISE NOTICE output is visible at all:
 * node-postgres emits notices as an event and drops them on the floor if nothing subscribes.
 */
function attachNoticeListener(client, label) {
  client.on('notice', (msg) => {
    const text = (msg?.message ?? String(msg)).trim();
    if (text) console.log(`    [notice] ${label}: ${text}`);
  });
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example and fill it in; values are never committed.');
    process.exit(2);
  }

  const files = await loadMigrations();

  const admin = new pg.Client({ connectionString });
  attachNoticeListener(admin, 'runner');
  await admin.connect();

  try {
    await admin.query(BOOTSTRAP_SQL);

    const { rows: applied } = await admin.query(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]));

    const drifted = files.filter(
      (f) => appliedMap.has(f.name) && appliedMap.get(f.name) !== f.checksum,
    );
    if (drifted.length > 0) {
      console.error('Applied migrations have been edited since they ran:');
      for (const f of drifted) console.error(`  ${f.name}`);
      console.error(
        'Migrations are forward-only. Restore the file and add a new numbered migration instead.',
      );
      process.exit(1);
    }

    const pending = files.filter((f) => !appliedMap.has(f.name));

    if (STATUS_ONLY) {
      console.log(`applied: ${appliedMap.size}   pending: ${pending.length}`);
      for (const f of pending) console.log(`  pending  ${f.name}`);
      return;
    }

    if (pending.length === 0) {
      console.log('Nothing to apply; the schema is up to date.');
      return;
    }

    const stopAfter = STOP_AFTER ? Number(STOP_AFTER) : Number.POSITIVE_INFINITY;
    const toApply = pending.filter((f) => f.number <= stopAfter);

    if (DRY_RUN) {
      console.log(`would apply ${toApply.length} migration(s):`);
      for (const f of toApply) console.log(`  ${f.name}`);
      return;
    }

    for (const file of toApply) {
      process.stdout.write(`applying ${file.name} ... `);
      const client = new pg.Client({ connectionString });
      attachNoticeListener(client, file.name);
      await client.connect();
      const started = Date.now();
      try {
        // One transaction per file. A file either lands whole or not at all.
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, number, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [file.name, file.number, file.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
        console.log(`ok (${Date.now() - started}ms)`);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* the connection may already be unusable; the original error is what matters */
        }
        console.log('FAILED');
        console.error(`\n${file.name} failed and was rolled back in full.\n`);
        console.error(`  ${err.severity ?? 'ERROR'}: ${err.message}`);
        if (err.detail) console.error(`  detail: ${err.detail}`);
        if (err.hint) console.error(`  hint:   ${err.hint}`);
        if (err.position) console.error(`  at character ${err.position}`);
        process.exitCode = 1;
        return;
      } finally {
        await client.end();
      }
    }

    console.log(`\nApplied ${toApply.length} migration(s).`);
    console.log('Next: node scripts/seed-framework.mjs to load the competency vocabulary.');
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
