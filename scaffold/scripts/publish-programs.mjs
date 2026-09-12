#!/usr/bin/env node
/**
 * publish-programs.mjs - publishes the seeded programs' current drafts, the same way the Publish
 * button does: status -> published, published_at, effective_from, the previous published version
 * of the same program retired, current_version_id moved. Only programs whose definition sits in
 * data/programs/ are touched; a hand-made draft is left alone. The findings the builder checks are
 * covered for these definitions by lib/program/__tests__/seed-programs.test.ts (no blockers).
 *
 *   npm run publish:programs
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { connect, KIT_ROOT } from './lib/kit-seed.mjs';

const DIR = path.resolve(KIT_ROOT, 'data', 'programs');
const codes = [];
for (const f of (await readdir(DIR)).filter((x) => x.endsWith('.json') && x !== 'retired.json')) codes.push(JSON.parse(await readFile(path.join(DIR, f), 'utf8')).template.code);

const client = await connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `SELECT t.id AS template_id, t.code, v.id AS version_id, v.version
       FROM session_templates t JOIN session_template_versions v ON v.id = t.current_version_id
      WHERE t.deleted_at IS NULL AND v.deleted_at IS NULL AND v.status = 'draft' AND t.code = ANY($1::text[]) ORDER BY t.code`, [codes]);
  for (const r of rows) {
    await client.query(`UPDATE session_template_versions SET status = 'retired' WHERE template_id = $1::uuid AND status = 'published' AND deleted_at IS NULL AND id <> $2::uuid`, [r.template_id, r.version_id]);
    await client.query(`UPDATE session_template_versions SET status = 'published', published_at = now(), effective_from = COALESCE(effective_from, CURRENT_DATE) WHERE id = $1::uuid`, [r.version_id]);
    await client.query(`INSERT INTO audit_log (actor_user_id, actor_label, action, entity_table, entity_id, capability_code, details) VALUES (NULL, 'scripts/publish-programs.mjs', 'template.publish', 'session_template_versions', $1::uuid, 'training.templates.configure', $2::jsonb)`, [r.version_id, JSON.stringify({ code: r.code, version: r.version, by: 'seed' })]);
  }
  await client.query('COMMIT');
  const already = codes.length - rows.length;
  console.log(`published ${rows.length} program draft(s)${already ? `; ${already} already published or not seeded` : ''}: ${rows.map((r) => r.code).join(', ') || '(none)'}`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
