#!/usr/bin/env node
/**
 * seed-library.mjs - the element library from data/library/*.json.
 *
 *   data/library/a320-malfunctions.json    the A320 IOS malfunction INDEX: button title, ATA
 *                                          chapter, engine applicability, options. Names only -
 *                                          the source document's effect and cue text is its
 *                                          owner's and is not reproduced.
 *   data/library/a320-guide-library.json   tasks, blocks, injects, set-up conditions, notes and
 *                                          equivalency groups derived from the STRUCTURE of the
 *                                          operator's instructor guide, every identifying value
 *                                          substituted (docs/06_PROGRAM_BUILDER.md section 4.1).
 *
 * Idempotent: upsert by code (the live partial unique index), never a DELETE; a code that stops
 * appearing in the file stays in the library, inactive by hand if wanted. Element kind is a tag,
 * fleet is a `fleet:<code>` tag (migration 0144). LIBRARY_DATA_DIR overrides the folder.
 *
 *   npm run seed:library
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { connect, KIT_ROOT } from './lib/kit-seed.mjs';

const DATA_DIR = process.env.LIBRARY_DATA_DIR ?? path.resolve(KIT_ROOT, 'data', 'library');

/** Mirrors lib/program/library.ts LIBRARY_KINDS - kind tag -> element_type. */
const KIND_TYPE = {
  task: 'task', block: 'section', malfunction: 'event_option', inject: 'event_option',
  airport: 'setup', weather: 'setup', mass_config: 'setup', position: 'setup', reset: 'setup', atc_script: 'setup', note: 'note',
};
const KIND_LABEL = { airport: 'Airport', weather: 'Weather', mass_config: 'Mass & config', position: 'Position', reset: 'Reset', atc_script: 'ATC' };

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function readJson(name) {
  const file = path.join(DATA_DIR, name);
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (err) { throw new Error(`cannot read ${file}: ${err.message}`); }
}

function malfunctionRow(m, fleet) {
  const options = m.options.length
    ? m.options.map((o) => ({ key: slug(o) || 'opt', name: `${m.title} · ${o}`, trigger: null }))
    : [{ key: 'set', name: m.title, trigger: null }];
  const tags = ['malfunction', `fleet:${fleet}`, ...(m.ata ? [`ata:${m.ata}`] : []), `group:${m.group}`];
  const summary = [m.ata ? `ATA ${m.ata} ${m.ata_label}` : m.ata_label, m.engines.join(', ') === 'ALL' ? null : m.engines.join(', '), m.options.length ? `options ${m.options.join(', ')}` : null].filter(Boolean).join(' · ');
  return { code: m.code, element_type: 'event_option', title: m.title, tags, content: { summary, ios: { title: m.title, ata: m.ata, ata_label: m.ata_label, engines: m.engines, group: m.group }, options } };
}

function guideRow(e, fleet) {
  const type = KIND_TYPE[e.kind];
  if (!type) throw new Error(`element ${e.code}: unknown kind ${e.kind}`);
  const tags = [e.kind, `fleet:${fleet}`, ...((e.te ?? []).map((t) => `te:${slug(t)}`))];
  const content = { summary: e.summary ?? null };
  switch (type) {
    case 'task': content.time = e.time ?? null; content.aims = { aims: e.text ?? null, competency_focus: null, grading_criteria: null, visibility: 'instructor_only' }; content.training_elements = e.te ?? []; break;
    case 'section': content.section_kind = 'block'; content.phase = e.phase ?? null; content.time = e.time ?? null; content.training_only = e.training_only === true; content.children = e.children ?? []; break;
    case 'event_option': content.options = [{ key: slug(e.title).slice(0, 40) || 'option', name: e.title, trigger: e.text ?? null }]; break;
    case 'setup': content.rows = [{ label: KIND_LABEL[e.kind] ?? e.kind, value: e.text ?? e.title }]; break;
    case 'note': content.text = e.text ?? e.title; break;
  }
  return { code: e.code, element_type: type, title: e.title, tags, content };
}

const malf = await readJson('a320-malfunctions.json');
const guide = await readJson('a320-guide-library.json');
const rows = [...malf.malfunctions.map((m) => malfunctionRow(m, malf.fleet)), ...guide.elements.map((e) => guideRow(e, guide.fleet))];

const client = await connect();
try {
  await client.query('BEGIN');
  const idByCode = new Map();
  for (const r of rows) {
    const { rows: out } = await client.query(
      `INSERT INTO element_library (code, element_type, title, tags, content, is_active)
       VALUES ($1, $2, $3, $4::text[], $5::jsonb, true)
       ON CONFLICT (code) WHERE deleted_at IS NULL
         DO UPDATE SET element_type = EXCLUDED.element_type, title = EXCLUDED.title, tags = EXCLUDED.tags, content = EXCLUDED.content, is_active = true
       RETURNING id`,
      [r.code, r.element_type, r.title, r.tags, JSON.stringify(r.content)]);
    idByCode.set(r.code, out[0].id);
  }
  let groups = 0, candidates = 0;
  for (const g of guide.equivalency_groups ?? []) {
    const { rows: out } = await client.query(
      `INSERT INTO equivalency_groups (code, name, description, candidate_type, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (code) WHERE deleted_at IS NULL
         DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, candidate_type = EXCLUDED.candidate_type, is_active = true
       RETURNING id`,
      [g.code, g.name, g.description ?? null, g.candidate_type ?? 'event_option']);
    const gid = out[0].id;
    groups += 1;
    for (const [i, code] of (g.candidates ?? []).entries()) {
      const lid = idByCode.get(code);
      if (!lid) throw new Error(`group ${g.code}: candidate ${code} is not in the library`);
      await client.query(
        `INSERT INTO equivalency_group_candidates (group_id, library_id, position) VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (group_id, library_id) DO UPDATE SET position = EXCLUDED.position, is_active = true`,
        [gid, lid, i]);
      candidates += 1;
    }
  }
  await client.query('COMMIT');
  const byKind = {};
  for (const r of rows) { const k = r.tags[0]; byKind[k] = (byKind[k] ?? 0) + 1; }
  console.log(`library seeded: ${rows.length} elements (${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')}); ${groups} equivalency groups, ${candidates} candidates`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
