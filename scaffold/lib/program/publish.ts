import 'server-only';
import type { PoolClient } from 'pg';
import { transaction } from '@/lib/db';
import { audit, type AuditActor, type RequestContext } from '@/lib/audit';
import { loadProgramVersion } from './index';

/**
 * lib/program/publish.ts - the version lifecycle: publish a draft, open a new draft from a version.
 *
 * What a session records is a VERSION, never "the program": sessions point at
 * session_template_versions.id, and migration 0021 makes a published version's content immutable
 * by trigger. So a correction after publishing is a NEW draft cloned from the published one,
 * edited, and published in turn; completed sessions keep reading the version they were flown on,
 * word for word. This module is the only path that changes a version's status.
 *
 *   publish       draft -> published. Refused when the rules report a blocker. The template's
 *                 previously published version becomes retired (one live version per program),
 *                 current_version_id moves to the new one.
 *   newDraft      any version -> a new draft (next version number) with the same set-up, roles,
 *                 elements and competencies. current_version_id stays where it is: a draft is not
 *                 what sessions get until it is published.
 *
 * Every change is one transaction with one audit row.
 */

export interface PublishOutcome { readonly ok: boolean; readonly message: string; readonly versionId?: string }

export async function publishVersion(versionId: string, userId: string, actor: AuditActor, ctx: RequestContext, client?: PoolClient): Promise<PublishOutcome> {
  const program = await loadProgramVersion(versionId);
  if (!program) return { ok: false, message: 'That version does not exist.' };
  if (program.version.status !== 'draft') return { ok: false, message: `Version ${program.version.version} of ${program.version.name} is ${program.version.status}, not a draft.` };
  const blockers = program.findings.filter((f) => f.severity === 'block');
  if (blockers.length) return { ok: false, message: `${program.version.name} v${program.version.version} has ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}: ${blockers.map((b) => b.message).join(' ')}` };
  if (program.problems.length) return { ok: false, message: `${program.version.name} v${program.version.version} has ${program.problems.length} content problem${program.problems.length === 1 ? '' : 's'}; fix them in the builder first.` };

  const run = async (c: PoolClient) => {
    const retired = await c.query(`UPDATE session_template_versions SET status = 'retired' WHERE template_id = $1::uuid AND status = 'published' AND deleted_at IS NULL AND id <> $2::uuid RETURNING id, version`, [program.version.template_id, versionId]);
    await c.query(`UPDATE session_template_versions SET status = 'published', published_at = now(), published_by = $2::uuid, effective_from = COALESCE(effective_from, CURRENT_DATE) WHERE id = $1::uuid`, [versionId, userId]);
    await c.query(`UPDATE session_templates SET current_version_id = $2::uuid WHERE id = $1::uuid`, [program.version.template_id, versionId]);
    await audit({ action: 'template.publish', entityTable: 'session_template_versions', entityId: versionId, capabilityCode: 'training.templates.configure', details: { code: program.version.code, version: program.version.version, retired: retired.rows.map((r) => r.version), warnings: program.findings.length } }, actor, ctx, c);
  };
  if (client) await run(client); else await transaction(run);
  return { ok: true, message: `${program.version.name} v${program.version.version} published.`, versionId };
}

export async function newDraftFrom(versionId: string, actor: AuditActor, ctx: RequestContext): Promise<PublishOutcome> {
  return transaction(async (c) => {
    const src = (await c.query<{ id: string; template_id: string; version: number; status: string; setup: unknown; notes: string | null; allowed_assessor_roles: string[]; hide_record_from_subject: boolean; code: string; name: string }>(
      `SELECT v.id, v.template_id, v.version, v.status, v.setup, v.notes, v.allowed_assessor_roles, v.hide_record_from_subject, t.code, t.name
         FROM session_template_versions v JOIN session_templates t ON t.id = v.template_id
        WHERE v.id = $1::uuid AND v.deleted_at IS NULL AND t.deleted_at IS NULL FOR UPDATE`, [versionId])).rows[0];
    if (!src) return { ok: false, message: 'That version does not exist.' };
    const open = (await c.query<{ id: string; version: number }>(`SELECT id, version FROM session_template_versions WHERE template_id = $1::uuid AND status = 'draft' AND deleted_at IS NULL`, [src.template_id])).rows[0];
    if (open) return { ok: false, message: `${src.name} already has an open draft (v${open.version}); edit or publish that one first.`, versionId: open.id };
    const next = (await c.query<{ n: number }>(`SELECT COALESCE(MAX(version), 0)::int + 1 AS n FROM session_template_versions WHERE template_id = $1::uuid`, [src.template_id])).rows[0]!.n;
    const draft = (await c.query<{ id: string }>(
      `INSERT INTO session_template_versions (template_id, version, status, setup, notes, allowed_assessor_roles, hide_record_from_subject)
       VALUES ($1::uuid, $2, 'draft', $3::jsonb, $4, $5::text[], $6) RETURNING id`,
      [src.template_id, next, JSON.stringify(src.setup ?? {}), src.notes, src.allowed_assessor_roles ?? [], src.hide_record_from_subject])).rows[0]!;
    await c.query(
      `INSERT INTO template_elements (template_version_id, element_key, parent_key, element_type, title, external_ref, position, is_mandatory, is_graded, max_attempts, content)
       SELECT $2::uuid, element_key, parent_key, element_type, title, external_ref, position, is_mandatory, is_graded, max_attempts, content
         FROM template_elements WHERE template_version_id = $1::uuid`, [versionId, draft.id]);
    await c.query(
      `INSERT INTO template_competencies (template_version_id, framework_id, competency_id, position, is_required)
       SELECT $2::uuid, framework_id, competency_id, position, is_required
         FROM template_competencies WHERE template_version_id = $1::uuid`, [versionId, draft.id]);
    await audit({ action: 'template.new_draft', entityTable: 'session_template_versions', entityId: draft.id, capabilityCode: 'training.templates.configure', details: { code: src.code, from_version: src.version, version: next } }, actor, ctx, c);
    return { ok: true, message: `${src.name}: draft v${next} opened from v${src.version}.`, versionId: draft.id };
  });
}
