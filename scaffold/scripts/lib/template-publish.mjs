/**
 * template-publish.mjs - publishing a template definition, shared by every caller.
 *
 * scripts/seed-templates.mjs publishes the four starter templates through this module, and
 * scripts/seed-synthetic.mjs publishes its own coverage template through the same one. There is no
 * second path into session_templates that skips the publish rules, because a template that reached
 * the database without passing them is a template the builder cannot open.
 *
 * The insert order here is not cosmetic. A version is created as a DRAFT, filled, and only then
 * published: migration 0021 blocks every write to the children of a published version with a
 * trigger, so publishing first makes the elements unwritable.
 */

import { resolveElementType, resolveTemplateKind } from './template-rules.mjs';

export class TemplateSeedError extends Error {}

/**
 * Reads the codes the template_kinds catalogue offers (migration 0032). Retired codes are excluded:
 * they exist so pre-0032 rows stay valid, and nothing new may be created under one.
 */
export async function allowedTemplateKinds(client) {
  const { rows } = await client.query('SELECT code FROM template_kinds WHERE is_active');
  if (rows.length === 0) {
    throw new TemplateSeedError(
      'the template_kinds catalogue is empty. Migration 0032 seeds it; run scripts/migrate.mjs ' +
        'before seeding templates.',
    );
  }
  return new Set(rows.map((r) => r.code));
}

/** Reads the values a CHECK constraint allows, so a mismatch is reported by name, not by errcode. */
export async function allowedCheckValues(client, table, column) {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype = 'c'`,
    [table],
  );
  for (const row of rows) {
    if (!row.def.includes(column)) continue;
    const values = [...row.def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
    if (values.length > 0) return new Set(values);
  }
  return null; // no parseable CHECK; let the database have the last word
}


export async function readFrameworkFromDb(client) {
  const { rows: fw } = await client.query(
    'SELECT id, code FROM competency_frameworks WHERE is_active ORDER BY created_at LIMIT 1',
  );
  if (fw.length === 0) {
    throw new TemplateSeedError(
      'no active competency framework. Run scripts/seed-framework.mjs first: templates reference ' +
        'competencies by CODE and resolve them to ids here, and a template that stores a name is ' +
        'exactly the failure the framework tables exist to prevent.',
    );
  }
  const frameworkId = fw[0].id;
  const { rows: comps } = await client.query(
    'SELECT id, code, "index" FROM competencies WHERE framework_id = $1 ORDER BY position',
    [frameworkId],
  );
  const { rows: obs } = await client.query(
    'SELECT id, code FROM observable_behaviours WHERE framework_id = $1',
    [frameworkId],
  );
  return {
    frameworkId,
    frameworkCode: fw[0].code,
    competencyIdByCode: new Map(comps.map((c) => [c.code, c.id])),
    competencyOrder: comps.map((c) => c.code),
    obIdByCode: new Map(obs.map((o) => [o.code, o.id])),
  };
}


/**
 * Builds the content JSONB actually stored: competency and observable-behaviour CODES resolved to
 * ids, nothing else changed.
 *
 * `content.catalogue_type` used to be written here because the element's real type had nowhere else
 * to live - migration 0021 allowed six element_type values and the catalogue has eight. Migration
 * 0033 widened the column, so the type is stored in the column it belongs in and a renderer that
 * switched on content.catalogue_type now switches on element_type.
 */
function storedContent(element, framework) {
  const content = { ...(element.content ?? {}) };
  if (Array.isArray(content.competency_codes)) {
    // Codes go in, ids come out. Nothing downstream reads a code or a name from an element.
    content.competency_ids = content.competency_codes.map((code) => framework.competencyIdByCode.get(code));
    delete content.competency_codes;
  }
  if (Array.isArray(content.observable_behaviour_codes)) {
    content.observable_behaviour_ids = content.observable_behaviour_codes.map((code) =>
      framework.obIdByCode.get(code),
    );
    delete content.observable_behaviour_codes;
  }
  return content;
}


export async function publishDefinition(client, { file, definition }, ctx) {
  const { policy, framework, effectiveFrom, allowedKinds, allowedElementTypes } = ctx;
  const templateKind = resolveTemplateKind(policy, definition.kind, allowedKinds);
  const version = policy.templates.seed_version;

  const assetClassId = definition.asset_class_code
    ? (await client.query('SELECT id FROM asset_classes WHERE code = $1 AND deleted_at IS NULL', [definition.asset_class_code])).rows[0]?.id ?? null
    : null;
  const orgUnitId = definition.org_unit_code
    ? (await client.query('SELECT id FROM org_units WHERE code = $1 AND deleted_at IS NULL', [definition.org_unit_code])).rows[0]?.id ?? null
    : null;

  const { rows: tRows } = await client.query(
    `INSERT INTO session_templates (code, name, template_kind, asset_class_id, org_unit_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (code) WHERE deleted_at IS NULL DO UPDATE
       SET name = EXCLUDED.name, template_kind = EXCLUDED.template_kind
     RETURNING id`,
    [definition.code, definition.name, templateKind, assetClassId, orgUnitId],
  );
  const templateId = tRows[0].id;

  // Rule 6: no published version with the same effective date.
  const { rows: clash } = await client.query(
    `SELECT version FROM session_template_versions
      WHERE template_id = $1 AND status = 'published' AND effective_from = $2 AND deleted_at IS NULL`,
    [templateId, effectiveFrom],
  );

  const { rows: existing } = await client.query(
    'SELECT id, status FROM session_template_versions WHERE template_id = $1 AND version = $2',
    [templateId, version],
  );
  if (existing.length > 0 && existing[0].status === 'published') {
    return { file, code: definition.code, kind: templateKind, action: 'exists', elements: 0, competencies: 0 };
  }
  if (clash.length > 0) {
    throw new TemplateSeedError(
      `${definition.code}: a published version (${clash[0].version}) already carries effective_from ` +
        `${effectiveFrom}. Publish under a different date; two published versions effective on the ` +
        'same day make "which version was this session graded against" unanswerable.',
    );
  }

  // Inserted as a DRAFT. Migration 0021's trigger blocks every child write on a published version.
  const { rows: vRows } = await client.query(
    `INSERT INTO session_template_versions
       (template_id, version, status, framework_id, period, setup, allowed_assessor_roles,
        hide_record_from_subject, notes)
     VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8)
     ON CONFLICT (template_id, version) DO UPDATE
       SET status = 'draft', framework_id = EXCLUDED.framework_id, setup = EXCLUDED.setup,
           allowed_assessor_roles = EXCLUDED.allowed_assessor_roles,
           hide_record_from_subject = EXCLUDED.hide_record_from_subject, notes = EXCLUDED.notes
     RETURNING id`,
    [
      templateId, version, framework.frameworkId, definition.version?.period ?? null,
      JSON.stringify(definition.version?.setup ?? {}),
      definition.version?.allowed_assessor_roles ?? [],
      definition.version?.hide_record_from_subject ?? false,
      definition.version?.change_note ?? definition.version?.notes ?? null,
    ],
  );
  const versionId = vRows[0].id;

  await client.query('DELETE FROM template_elements WHERE template_version_id = $1', [versionId]);
  await client.query('DELETE FROM template_competencies WHERE template_version_id = $1', [versionId]);

  for (const element of definition.elements) {
    const catalogue = resolveElementType(policy, element.catalogue_type, allowedElementTypes);
    await client.query(
      `INSERT INTO template_elements
         (template_version_id, element_key, parent_key, element_type, title, external_ref,
          position, is_mandatory, is_graded, max_attempts, content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        versionId, element.element_key, element.parent_key ?? null, catalogue.type,
        element.title ?? null, element.external_ref ?? null, element.position,
        element.is_mandatory ?? false, catalogue.graded === true,
        catalogue.graded ? element.content?.allow_attempts ?? 1 : null,
        JSON.stringify(storedContent(element, framework)),
      ],
    );
  }

  const required = definition.competencies_required !== false;
  let position = 0;
  for (const code of definition.competencies) {
    await client.query(
      `INSERT INTO template_competencies
         (template_version_id, framework_id, competency_id, position, is_required)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (template_version_id, competency_id) DO NOTHING`,
      [versionId, framework.frameworkId, framework.competencyIdByCode.get(code), position, required],
    );
    position += 1;
  }

  await client.query(
    `UPDATE session_template_versions
        SET status = 'published', effective_from = $2, published_at = now()
      WHERE id = $1`,
    [versionId, effectiveFrom],
  );
  await client.query('UPDATE session_templates SET current_version_id = $2 WHERE id = $1', [
    templateId, versionId,
  ]);

  return {
    file, code: definition.code, kind: templateKind, action: 'published',
    elements: definition.elements.length, competencies: definition.competencies.length,
  };
}
