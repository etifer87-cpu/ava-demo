/**
 * verify/schema.mjs - is the schema the one this release ships?
 *
 * Everything below is a statement about the DATABASE compared with the FILES in the checkout.
 * Nothing here is a statement about the data, and nothing here takes a date.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCAFFOLD_ROOT } from '../lib/kit-seed.mjs';

const MIGRATIONS_DIR = path.join(SCAFFOLD_ROOT, 'db', 'migrations');
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** The runner's checksum, byte for byte: sha256 of the file text, first 32 hex characters. */
const checksum = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

async function migrationFiles() {
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort();
  const out = [];
  for (const name of names) {
    if (!FILE_RE.test(name)) throw new Error(`migration file "${name}" is not NNNN_lower_snake.sql`);
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    out.push({ name, number: Number(FILE_RE.exec(name)[1]), checksum: checksum(sql) });
  }
  return out.sort((a, b) => a.number - b.number);
}

export const checks = [
  {
    name: 'every migration file on disk is applied',
    async run({ client }) {
      const files = await migrationFiles();
      const { rows } = await client.query('SELECT filename FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.filename));
      const pending = files.filter((f) => !applied.has(f.name));
      return {
        ok: pending.length === 0,
        detail: pending.length === 0
          ? `${files.length} migrations, head ${files[files.length - 1]?.name ?? '(none)'}`
          : `pending: ${pending.map((f) => f.name).join(', ')}`,
      };
    },
  },
  {
    name: 'no applied migration was edited after it ran',
    async run({ client }) {
      const files = await migrationFiles();
      const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
      const byName = new Map(rows.map((r) => [r.filename, r.checksum]));
      const drifted = files.filter((f) => byName.has(f.name) && byName.get(f.name) !== f.checksum);
      const unknown = rows.filter((r) => !files.some((f) => f.name === r.filename));
      const problems = [
        ...drifted.map((f) => `${f.name} edited since it ran`),
        ...unknown.map((r) => `${r.filename} is applied but is not in the checkout`),
      ];
      return {
        ok: problems.length === 0,
        detail: problems.length === 0 ? `${rows.length} checksums intact` : problems.join('; '),
      };
    },
  },
  {
    name: 'every table and view carries a comment',
    async run({ client }) {
      const { rows } = await client.query(`
        SELECT c.relname, CASE c.relkind WHEN 'r' THEN 'table' ELSE 'view' END AS kind
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
           AND obj_description(c.oid, 'pg_class') IS NULL
         ORDER BY 1`);
      const { rows: counted } = await client.query(`
        SELECT count(*) FILTER (WHERE c.relkind = 'r') AS tables,
               count(*) FILTER (WHERE c.relkind = 'v') AS views
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')`);
      return {
        ok: rows.length === 0,
        detail: rows.length === 0
          ? `${counted[0].tables} tables, ${counted[0].views} views, all commented`
          : `uncommented: ${rows.map((r) => `${r.kind} ${r.relname}`).join(', ')}`,
      };
    },
  },
  {
    name: 'every delete guard the migrations declare is installed',
    async run({ client }) {
      // Derived from the migration text, not from a list kept here: a migration that attaches a
      // guard to a new table extends this assertion by existing, and a guard that was dropped in
      // the database while the migration still declares it is exactly the drift being looked for.
      const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort();
      const declared = new Set();
      for (const name of names) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
        const stripped = sql.replace(/^\s*--.*$/gm, '');
        // Statement by statement. Matched across the whole file, a greedy scan pairs the name of
        // one CREATE TRIGGER with the function of a later one and reports guards that were never
        // declared - which is a false failure, and a false failure in a gate is worse than none.
        for (const statement of stripped.split(';')) {
          const m = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)[\s\S]*?\bON\s+(\w+)[\s\S]*?EXECUTE\s+FUNCTION\s+(deny_hard_delete|deny_mutation)\s*\(\)/i
            .exec(statement);
          if (m) declared.add(`${m[2]}|${m[1]}|${m[3]}`);
        }
      }
      const { rows } = await client.query(`
        SELECT c.relname AS table_name, t.tgname AS trigger_name, p.proname AS function_name
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc p ON p.oid = t.tgfoid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND n.nspname = 'public'
           AND p.proname IN ('deny_hard_delete', 'deny_mutation')`);
      const installed = new Set(rows.map((r) => `${r.table_name}|${r.trigger_name}|${r.function_name}`));
      const missing = [...declared].filter((d) => !installed.has(d));
      return {
        ok: declared.size > 0 && missing.length === 0,
        detail: declared.size === 0
          ? 'no delete guard is declared by any migration, which cannot be right'
          : missing.length === 0
            ? `${declared.size} guards declared, all installed`
            : `missing: ${missing.map((d) => d.split('|').slice(0, 2).join('.')).join(', ')}`,
      };
    },
  },
];
