/**
 * kit-seed.mjs - the shared floor under every seed script.
 *
 * Four things live here and nowhere else:
 *   1. a deterministic pseudo-random generator, so "same seed, same output" is a property of the
 *      code rather than a hope;
 *   2. a small YAML reader for scaffold/config/*.yaml, so the seed scripts need no dependency
 *      beyond the pg driver they already need;
 *   3. the analytics-config reader, which reads thresholds FROM THE DATABASE - never from a
 *      literal, never from disk - and fails loudly when the config has not been loaded;
 *   4. config_versions bookkeeping, so a seeded database can name the configuration it was
 *      built under.
 *
 * ORDERING, which is the trap this module exists to make impossible to get wrong:
 * migrate -> load config -> everything else. Anything that reads a threshold before
 * load-analytics-config.mjs has run gets an exception here rather than a plausible default.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = path.resolve(HERE, '..', '..', '..');
export const SCAFFOLD_ROOT = path.resolve(KIT_ROOT, 'scaffold');

/* ========================================================================= *
 * 1. Deterministic randomness
 * ========================================================================= */

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A seeded generator. Two rules make the output reproducible in practice and not only in theory:
 *   - every stream is NAMED, so adding a draw in one place does not shift every later value;
 *   - nothing in a seed script may call Math.random(), Date.now() or crypto.randomUUID().
 * Ids come from the database's own gen_random_uuid(): the generator never invents one, because a
 * generated uuid would make two runs differ in the one column everything joins on.
 */
export function makeRng(seedText, streamName = 'default') {
  let state = (fnv1a(`${seedText}:${streamName}`) + 0x6d2b79f5) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    sample: (items, n) => {
      const pool = [...items];
      const out = [];
      while (out.length < n && pool.length > 0) {
        out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      }
      return out;
    },
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    normal: (mean, sd) => {
      const u = Math.max(next(), 1e-9);
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    fork: (name) => makeRng(seedText, `${streamName}/${name}`),
  };
}

/* ========================================================================= *
 * 2. Dates
 * ========================================================================= */

export const isoDate = (d) => d.toISOString().slice(0, 10);
export const parseDate = (s) => new Date(`${s}T00:00:00Z`);

export function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export const monthKey = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
export const quarterKey = (d) =>
  `${d.getUTCFullYear()}-${String(Math.floor(d.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;

export function monthsBetween(from, to) {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

/* ========================================================================= *
 * 3. YAML subset reader
 *
 * Handles exactly what scaffold/config/*.yaml uses: block maps, block sequences, flow maps, flow
 * sequences, quoted and bare scalars, comments, null / true / false / numbers. It REJECTS anything
 * else by name rather than guessing, because a config reader that silently mis-parses a threshold
 * is the worst possible failure in a system whose whole point is that thresholds are configuration.
 * ========================================================================= */

class YamlError extends Error {}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
      (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  if (text.startsWith('[') || text.startsWith('{')) return parseFlow(text);
  return text;
}

/** Splits a flow collection body on top-level commas, respecting quotes and nesting. */
function splitFlow(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim() !== '') parts.push(tail);
  return parts;
}

function parseFlow(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) throw new YamlError(`unterminated flow sequence: ${text}`);
    return splitFlow(trimmed.slice(1, -1)).map((p) => parseScalar(p));
  }
  if (!trimmed.endsWith('}')) throw new YamlError(`unterminated flow mapping: ${text}`);
  const out = {};
  for (const part of splitFlow(trimmed.slice(1, -1))) {
    const at = part.indexOf(':');
    if (at < 0) throw new YamlError(`flow mapping entry without a key: ${part}`);
    out[part.slice(0, at).trim().replace(/^["']|["']$/g, '')] = parseScalar(part.slice(at + 1));
  }
  return out;
}

const isSeqLine = (line, indent) => line.indent === indent && line.text.startsWith('- ');

function blockEnd(lines, index, indent) {
  let i = index;
  while (i < lines.length && lines[i].indent >= indent) i += 1;
  return i;
}

function seqEnd(lines, index, indent) {
  let i = index;
  while (i < lines.length && (lines[i].indent > indent || isSeqLine(lines[i], indent))) i += 1;
  return i;
}

function parseBlock(lines, index, indent) {
  if (lines[index] && isSeqLine(lines[index], indent)) return parseSequence(lines, index, indent);
  return parseMap(lines, index, indent);
}

function parseMap(lines, index, indent) {
  const out = {};
  let i = index;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(`unexpected indent at line ${line.no}: ${line.text}`);
    if (line.text.startsWith('- ')) break;
    const at = line.text.indexOf(':');
    if (at < 0) throw new YamlError(`expected "key: value" at line ${line.no}: ${line.text}`);
    const key = line.text.slice(0, at).trim().replace(/^["']|["']$/g, '');
    const rest = line.text.slice(at + 1).trim();
    if (rest !== '') {
      out[key] = parseScalar(rest);
      i += 1;
      continue;
    }
    const next = lines[i + 1];
    if (!next) {
      out[key] = null;
      i += 1;
      continue;
    }
    if (next.indent > indent) {
      out[key] = parseBlock(lines, i + 1, next.indent);
      i = blockEnd(lines, i + 1, next.indent);
      continue;
    }
    if (isSeqLine(next, indent)) {
      out[key] = parseSequence(lines, i + 1, indent);
      i = seqEnd(lines, i + 1, indent);
      continue;
    }
    out[key] = null;
    i += 1;
  }
  return out;
}

function parseSequence(lines, index, indent) {
  const out = [];
  let i = index;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError(`unexpected indent at line ${line.no}: ${line.text}`);
    if (!line.text.startsWith('- ')) break;
    const body = line.text.slice(2).trim();
    if (body.startsWith('[') || body.startsWith('{')) {
      out.push(parseFlow(body));
      i += 1;
      continue;
    }
    const at = body.indexOf(':');
    const looksLikeMapEntry = at > 0 && (body[at + 1] === ' ' || at === body.length - 1);
    if (!looksLikeMapEntry) {
      out.push(parseScalar(body));
      i += 1;
      continue;
    }
    // A block map inside a sequence item: the item's own indent is the dash column plus two.
    const itemIndent = line.indent + 2;
    const synthetic = [{ indent: itemIndent, text: body, no: line.no }];
    let j = i + 1;
    while (j < lines.length && lines[j].indent >= itemIndent && !isSeqLine(lines[j], indent)) {
      synthetic.push(lines[j]);
      j += 1;
    }
    out.push(parseMap(synthetic, 0, itemIndent));
    i = j;
  }
  return out;
}

export function parseYaml(text) {
  const lines = [];
  text.split('\n').forEach((raw, idx) => {
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === '') return;
    if (withoutComment.trimStart().startsWith('---')) return;
    lines.push({
      indent: withoutComment.length - withoutComment.trimStart().length,
      text: withoutComment.trim(),
      no: idx + 1,
    });
  });
  if (lines.length === 0) return {};
  return parseBlock(lines, 0, lines[0].indent);
}

export const checksumOf = (text) =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

export async function readYamlFile(relativePath) {
  const full = path.resolve(SCAFFOLD_ROOT, relativePath);
  const text = await readFile(full, 'utf8');
  try {
    return { path: full, text, checksum: checksumOf(text), data: parseYaml(text) };
  } catch (err) {
    throw new YamlError(`${relativePath}: ${err.message}`);
  }
}

export async function loadPolicy() {
  const file = await readYamlFile('config/policy.yaml');
  if (!file.data?.version) throw new YamlError('config/policy.yaml has no version');
  if (!file.data?.synthetic) throw new YamlError('config/policy.yaml has no synthetic section');
  if (!Array.isArray(file.data?.template_kinds)) {
    throw new YamlError('config/policy.yaml has no template_kinds list');
  }
  return file;
}

/* ========================================================================= *
 * 4. Analytics config, read from the database
 * ========================================================================= */

export class ConfigOrderError extends Error {}

/**
 * Reads analytics_config into a typed accessor. Raises when the table is empty, which is exactly
 * what happens when a script runs before scripts/load-analytics-config.mjs. Every threshold a seed
 * script needs comes from here; none is written down a second time.
 */
export async function readAnalyticsConfig(client) {
  const { rows } = await client.query(
    'SELECT key, value_num, value_text, value_json, config_version FROM analytics_config',
  );
  if (rows.length === 0) {
    throw new ConfigOrderError(
      'analytics_config is empty. Run scripts/load-analytics-config.mjs after migrating and ' +
        'BEFORE any script that reads a threshold. Ordering is the whole point: a seed that runs ' +
        'first reads no thresholds at all, and every band it was supposed to exercise silently ' +
        'fails to occur.',
    );
  }
  const map = new Map(rows.map((r) => [r.key, r]));
  const require_ = (key) => {
    const row = map.get(key);
    if (!row) {
      throw new ConfigOrderError(
        `analytics_config key "${key}" is not loaded. It exists in scaffold/config/analytics.yaml; ` +
          'reload the config rather than adding a default here - a default in a script is a ' +
          'hardcoded threshold.',
      );
    }
    return row;
  };
  return {
    version: rows[0].config_version,
    size: rows.length,
    num: (key) => Number(require_(key).value_num),
    int: (key) => Math.round(Number(require_(key).value_num)),
    text: (key) => require_(key).value_text,
    json: (key) => require_(key).value_json,
    has: (key) => map.has(key),
  };
}

/** Records a config file in config_versions and activates it. Idempotent on (name, version). */
export async function recordConfigVersion(client, { name, version, checksum, payload, notes }) {
  await client.query('UPDATE config_versions SET is_active = false WHERE name = $1', [name]);
  const { rows } = await client.query(
    `INSERT INTO config_versions (name, version, checksum, payload, is_active, notes)
     VALUES ($1,$2,$3,$4,true,$5)
     ON CONFLICT (name, version) DO UPDATE
       SET checksum = EXCLUDED.checksum,
           payload = EXCLUDED.payload,
           is_active = true,
           notes = EXCLUDED.notes,
           loaded_at = now()
     RETURNING id`,
    [name, version, checksum, JSON.stringify(payload), notes ?? null],
  );
  return rows[0].id;
}

/* ========================================================================= *
 * 5. Connection and CLI helpers
 * ========================================================================= */

export async function connect() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. See .env.example; values are never committed.');
  }
  // Imported lazily so that --dry-run modes run on a checkout with no node_modules.
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  // Without this listener node-postgres discards every RAISE NOTICE, and the assertions in
  // migration 0041 and in the analytics views appear to have printed nothing at all.
  client.on('notice', (msg) => {
    const text = (msg?.message ?? '').trim();
    if (text) console.log(`    [notice] ${text}`);
  });
  await client.connect();
  return client;
}

export function argValue(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) return args[i + 1];
  return fallback;
}

export const argFlag = (name) => process.argv.slice(2).includes(name);

/** Renders a summary table. Every seed script prints one; a silent seed is unverifiable. */
export function renderTable(headers, rows) {
  const all = [headers, ...rows.map((r) => r.map((c) => String(c)))];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...all.slice(1).map(line)].join('\n');
}
