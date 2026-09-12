#!/usr/bin/env node
/**
 * seed-program.mjs - loads a program definition from data/programs/*.json into the builder.
 *
 *   npm run seed:program                      every file in data/programs/
 *   npm run seed:program -- <file.json>       one file
 *
 * A definition is a template plus a tree of elements in the same shapes the builder writes
 * (lib/program/shape.ts), keyed by hand so the seed is stable. Idempotent on the DRAFT: the
 * template is upserted by code; if its current version is a draft, the elements are replaced
 * from the file; a published version is never touched (0021 would refuse anyway) and the script
 * says so. Grades never exist on a draft, so replacing its elements loses nothing.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { connect, KIT_ROOT, argValue } from './lib/kit-seed.mjs';

const DIR = process.env.PROGRAM_DATA_DIR ?? path.resolve(KIT_ROOT, 'data', 'programs');
const only = process.argv.slice(2).find((a) => a.endsWith('.json')) ?? argValue('file', null);
const files = only ? [path.isAbsolute(only) ? only : path.join(DIR, only)] : (await readdir(DIR)).filter((f) => f.endsWith('.json')).map((f) => path.join(DIR, f));
if (files.length === 0) { console.error(`no program definitions in ${DIR}`); process.exit(1); }

const client = await connect();
try {
  for (const file of files) {
    const def = JSON.parse(await readFile(file, 'utf8'));
    const t = def.template;
    await client.query('BEGIN');
    try {
      const kind = await client.query(`SELECT 1 FROM template_kinds WHERE code = $1 AND is_active`, [t.kind]);
      if (!kind.rows.length) throw new Error(`${path.basename(file)}: template kind "${t.kind}" is not in the catalogue`);
      const fleet = t.fleet ? (await client.query(`SELECT id FROM asset_classes WHERE code = $1 AND deleted_at IS NULL`, [t.fleet])).rows[0]?.id ?? null : null;
      if (t.fleet && !fleet) throw new Error(`${path.basename(file)}: fleet "${t.fleet}" is not an asset class; run seed:operator first`);

      let tpl = (await client.query(`SELECT id, current_version_id FROM session_templates WHERE code = $1 AND deleted_at IS NULL`, [t.code])).rows[0];
      if (!tpl) {
        tpl = (await client.query(`INSERT INTO session_templates (code, name, template_kind, asset_class_id) VALUES ($1, $2, $3, $4::uuid) RETURNING id, current_version_id`, [t.code, t.name, t.kind, fleet])).rows[0];
      } else {
        await client.query(`UPDATE session_templates SET name = $2, is_active = true WHERE id = $1::uuid`, [tpl.id, t.name]);
      }
      let version = tpl.current_version_id ? (await client.query(`SELECT id, status, version FROM session_template_versions WHERE id = $1::uuid AND deleted_at IS NULL`, [tpl.current_version_id])).rows[0] : null;
      if (version && version.status !== 'draft') {
        console.log(`${t.code}: version ${version.version} is ${version.status}; not touched. Clone it to a draft to reseed.`);
        await client.query('COMMIT');
        continue;
      }
      if (!version) {
        version = (await client.query(`INSERT INTO session_template_versions (template_id, version, status, setup, notes) VALUES ($1::uuid, 1, 'draft', $2::jsonb, $3) RETURNING id, status, version`, [tpl.id, JSON.stringify(t.setup ?? {}), t.notes ?? null])).rows[0];
        await client.query(`UPDATE session_templates SET current_version_id = $2::uuid WHERE id = $1::uuid`, [tpl.id, version.id]);
      } else {
        await client.query(`UPDATE session_template_versions SET setup = $2::jsonb, notes = $3 WHERE id = $1::uuid`, [version.id, JSON.stringify(t.setup ?? {}), t.notes ?? null]);
        await client.query(`DELETE FROM template_elements WHERE template_version_id = $1::uuid`, [version.id]);
      }

      // Elements: depth-first, positions contiguous per parent, keys as authored.
      let n = 0;
      const insert = async (el, parentKey, position) => {
        const type = el.type;
        const graded = type === 'task' && el.content?.grading && (el.content.grading.task_outcome_mode !== 'none' || el.content.grading.competency_grade_mode !== 'none');
        await client.query(
          `INSERT INTO template_elements (template_version_id, element_key, parent_key, element_type, title, position, is_graded, content) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [version.id, el.key, parentKey, type, el.title, position, Boolean(graded), JSON.stringify(el.content ?? {})]);
        n += 1;
        for (const [i, child] of (el.children ?? []).entries()) await insert(child, el.key, i);
      };
      for (const [i, el] of def.elements.entries()) await insert(el, null, i);

      // The version assesses the union of the competencies its exercises target.
      const framework = (await client.query(`SELECT id FROM competency_frameworks WHERE is_active`)).rows[0];
      const codes = new Set();
      const walk = (els) => { for (const e of els) { for (const c of e.content?.grading?.competencies ?? []) codes.add(c); walk(e.children ?? []); } };
      walk(def.elements);
      await client.query(`DELETE FROM template_competencies WHERE template_version_id = $1::uuid`, [version.id]);
      let pos = 0;
      for (const code of def.competencies_default ?? []) {
        if (!codes.has(code) && (def.competencies_default ?? []).length !== 9) continue;
        const comp = (await client.query(`SELECT id FROM competencies WHERE framework_id = $1::uuid AND code = $2`, [framework.id, code])).rows[0];
        if (!comp) throw new Error(`competency ${code} is not in the active framework`);
        await client.query(`INSERT INTO template_competencies (template_version_id, framework_id, competency_id, position, is_required) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`, [version.id, framework.id, comp.id, pos++, codes.has(code)]);
      }
      await client.query('COMMIT');
      console.log(`${t.code}: "${t.name}" v${version.version} draft, ${n} elements, competencies targeted ${[...codes].join(' ') || '(none)'}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
} finally {
  await client.end();
}
