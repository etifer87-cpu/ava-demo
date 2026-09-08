#!/usr/bin/env node
/**
 * seed-framework.mjs - loads the competency vocabulary.
 *
 * Source: scaffold/db/seed/competency_framework.json, which is GENERATED from
 * docs/03_COMPETENCY_FRAMEWORK.md by scaffold/scripts/build-framework-seed.py.
 *
 * This script asserts every rule in docs/03 section 6 and fails loudly on any mismatch. A
 * half-loaded vocabulary is worse than none: every grade written against it carries a
 * competency_id that resolves to the wrong thing, and nothing in the platform will notice.
 *
 *   1. exactly 9 competencies, codes and order as docs/03 section 2;
 *   2. OB counts per competency 7,7,10,6,7,11,9,7,9, total 73;
 *   3. every OB code matches ^OB [0-8]\.\d{1,2}$ and is unique;
 *   4. OB text byte-matches docs/03 - re-parsed here, independently of the generator;
 *   5. every competency colour passes the contrast rule (docs/13_DESIGN_SYSTEM.md).
 *
 * Idempotent: re-running after a wording change UPDATEs names, texts and colours in place.
 * Ids are never re-minted, because every grade in the database points at them.
 *
 * Usage:
 *   node scripts/seed-framework.mjs
 *   node scripts/seed-framework.mjs --dry-run     assert only, write nothing
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The pg driver is imported LAZILY, inside main(). --dry-run is a pure validation of the seed
// against docs/03 and must run on a checkout with no node_modules at all: a validator that needs
// a database driver to tell you your JSON drifted is a validator nobody runs.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, '..', '..');
const SEED_FILE = path.resolve(KIT, 'scaffold', 'db', 'seed', 'competency_framework.json');
const DOC_FILE = path.resolve(KIT, 'docs', '03_COMPETENCY_FRAMEWORK.md');

const DRY_RUN = process.argv.includes('--dry-run');

const OB_CODE_RE = /^OB [0-8]\.\d{1,2}$/;
const EXPECTED_OB_COUNTS = [7, 7, 10, 6, 7, 11, 9, 7, 9];

class SeedError extends Error {}

function assert(condition, message) {
  if (!condition) throw new SeedError(message);
}

/* ------------------------------------------------------------------------- *
 * Assertion 5 - contrast. The authority is docs/13_DESIGN_SYSTEM.md; this is the
 * mechanical check it specifies. A colour is usable when it reaches 3:1 against at
 * least one of the two text colours the platform draws on top of a fill.
 * ------------------------------------------------------------------------- */

function relativeLuminance(hex) {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const CONTRAST_MIN = 3.0;
const FOREGROUNDS = ['#FFFFFF', '#111111'];

/* ------------------------------------------------------------------------- *
 * Assertion 4 - an independent re-parse of docs/03, so the JSON and the document
 * are compared by two different implementations rather than by one talking to itself.
 * ------------------------------------------------------------------------- */

function parseDocObservableBehaviours(markdown) {
  const lines = markdown.split('\n');
  const byCompetency = new Map();
  let inSection = false;
  let current = null;
  for (const line of lines) {
    if (line.startsWith('## 3.')) { inSection = true; continue; }
    if (inSection && line.startsWith('## ')) break;
    if (!inSection) continue;
    const heading = /^###\s+(\d)\s+·\s+([A-Z]{3})\b/.exec(line);
    if (heading) {
      current = heading[2];
      if (!byCompetency.has(current)) byCompetency.set(current, []);
      continue;
    }
    const row = /^\|\s*(OB \d\.\d{1,2})\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (row && current) byCompetency.get(current).push({ code: row[1], text: row[2] });
  }
  return byCompetency;
}

/* ------------------------------------------------------------------------- *
 * Validation
 * ------------------------------------------------------------------------- */

function validate(seed, docMarkdown) {
  assert(seed && typeof seed === 'object', 'seed file is not an object');
  assert(seed.framework?.code, 'seed.framework.code is missing');
  const competencies = seed.competencies;
  assert(Array.isArray(competencies), 'seed.competencies is not an array');

  // 1. nine competencies, in order.
  assert(competencies.length === 9, `expected 9 competencies, found ${competencies.length}`);
  competencies.forEach((c, i) => {
    assert(c.index === i, `competency ${c.code} has index ${c.index}, expected ${i}`);
    assert(/^[A-Z]{3}$/.test(c.code), `competency code ${c.code} is not three upper-case letters`);
    assert(typeof c.name === 'string' && c.name.length > 0, `competency ${c.code} has no name`);
  });
  const codes = competencies.map((c) => c.code);
  assert(new Set(codes).size === 9, `competency codes are not unique: ${codes.join(',')}`);

  // 2. OB counts.
  const counts = competencies.map((c) => c.observable_behaviours.length);
  assert(
    counts.join(',') === EXPECTED_OB_COUNTS.join(','),
    `OB counts per competency are ${counts.join(',')}, expected ${EXPECTED_OB_COUNTS.join(',')}`,
  );
  const total = counts.reduce((a, b) => a + b, 0);
  assert(total === 73, `expected 73 observable behaviours, found ${total}`);

  // 3. OB codes well formed, unique, and under the right competency.
  const seen = new Set();
  for (const c of competencies) {
    for (const ob of c.observable_behaviours) {
      assert(OB_CODE_RE.test(ob.code), `malformed OB code ${JSON.stringify(ob.code)}`);
      assert(!seen.has(ob.code), `duplicate OB code ${ob.code}`);
      seen.add(ob.code);
      assert(
        ob.code.startsWith(`OB ${c.index}.`),
        `${ob.code} is listed under competency index ${c.index}`,
      );
    }
  }

  // 4. byte-match against the document.
  const fromDoc = parseDocObservableBehaviours(docMarkdown);
  for (const c of competencies) {
    const docRows = fromDoc.get(c.code);
    assert(docRows, `docs/03 has no observable-behaviour block for ${c.code}`);
    assert(
      docRows.length === c.observable_behaviours.length,
      `${c.code}: seed has ${c.observable_behaviours.length} OBs, docs/03 has ${docRows.length}`,
    );
    c.observable_behaviours.forEach((ob, i) => {
      assert(ob.code === docRows[i].code, `${c.code} position ${i}: seed ${ob.code} vs doc ${docRows[i].code}`);
      assert(
        ob.text === docRows[i].text,
        `${ob.code} text does not byte-match docs/03.\n  seed: ${ob.text}\n  doc:  ${docRows[i].text}\n` +
          '  The seed is GENERATED. Re-run scripts/build-framework-seed.py rather than editing the JSON.',
      );
    });
  }

  // 5. colour contrast.
  const colours = new Set();
  for (const c of competencies) {
    assert(/^#[0-9A-F]{6}$/.test(c.colour), `competency ${c.code} colour ${c.colour} is malformed`);
    assert(!colours.has(c.colour), `competency colour ${c.colour} is used twice; spokes must be separable`);
    colours.add(c.colour);
    const best = Math.max(...FOREGROUNDS.map((fg) => contrastRatio(c.colour, fg)));
    assert(
      best >= CONTRAST_MIN,
      `competency ${c.code} colour ${c.colour} reaches only ${best.toFixed(2)}:1 against both ` +
        `#FFFFFF and #111111; docs/13_DESIGN_SYSTEM.md requires ${CONTRAST_MIN}:1`,
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Load
 * ------------------------------------------------------------------------- */

async function seed(client, data) {
  const fw = data.framework;

  // Exactly one framework is active (partial unique index in 0040). Stand the others down first,
  // or the INSERT below collides with a constraint whose message names an index, not a cause.
  if (fw.is_active) {
    await client.query('UPDATE competency_frameworks SET is_active = false WHERE code <> $1', [fw.code]);
  }

  const { rows: fwRows } = await client.query(
    `INSERT INTO competency_frameworks (code, name, edition, source_ref, effective_from, is_active)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name,
           edition = EXCLUDED.edition,
           source_ref = EXCLUDED.source_ref,
           effective_from = EXCLUDED.effective_from,
           is_active = EXCLUDED.is_active
     RETURNING id`,
    [fw.code, fw.name, fw.edition ?? null, fw.source_ref ?? null, fw.effective_from ?? null, fw.is_active !== false],
  );
  const frameworkId = fwRows[0].id;

  let obCount = 0;
  for (const c of data.competencies) {
    const { rows: compRows } = await client.query(
      `INSERT INTO competencies (framework_id, code, "index", name, description, colour, position, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (framework_id, code) DO UPDATE
         SET "index" = EXCLUDED."index",
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             colour = EXCLUDED.colour,
             position = EXCLUDED.position,
             is_active = true
       RETURNING id`,
      [frameworkId, c.code, c.index, c.name, c.description ?? null, c.colour, c.position ?? c.index],
    );
    const competencyId = compRows[0].id;

    for (const ob of c.observable_behaviours) {
      // framework_id is set by the sync_ob_framework trigger; it is passed anyway so the INSERT
      // is legal on a database where the trigger has been dropped.
      await client.query(
        `INSERT INTO observable_behaviours (competency_id, framework_id, code, text, position, is_active)
         VALUES ($1,$2,$3,$4,$5,true)
         ON CONFLICT (framework_id, code) DO UPDATE
           SET competency_id = EXCLUDED.competency_id,
               text = EXCLUDED.text,
               position = EXCLUDED.position,
               is_active = true`,
        [competencyId, frameworkId, ob.code, ob.text, ob.position],
      );
      obCount += 1;
    }
  }

  return { frameworkId, obCount };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const [seedText, docText] = await Promise.all([
    readFile(SEED_FILE, 'utf8'),
    readFile(DOC_FILE, 'utf8'),
  ]);
  const data = JSON.parse(seedText);

  validate(data, docText);
  console.log('framework seed validated against docs/03: 9 competencies, 73 observable behaviours');

  if (DRY_RUN) {
    console.log('--dry-run: nothing written');
    return;
  }
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example and fill it in; values are never committed.');
    process.exit(2);
  }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  client.on('notice', (msg) => console.log(`    [notice] ${(msg?.message ?? '').trim()}`));
  await client.connect();
  try {
    await client.query('BEGIN');
    const { frameworkId, obCount } = await seed(client, data);

    // The database's own assertion, from migration 0041. It raises rather than returning a row
    // set on any mismatch, and the transaction rolls back with it.
    await client.query('SELECT * FROM framework_seed_verify($1)', [frameworkId]);

    await client.query('COMMIT');
    console.log(`framework ${data.framework.code} loaded: id ${frameworkId}, ${obCount} observable behaviours`);
    console.log('Next: node scripts/seed-templates.mjs');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (err instanceof SeedError) {
    console.error(`\nframework seed REJECTED: ${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
