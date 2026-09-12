import 'server-only';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { loadProgramVersion, type LoadedProgram } from './index';

/**
 * lib/program/screens.ts - what the three program screens share: the template row, the version
 * to show, the version query string to carry between tabs.
 */

export interface TemplateHead { id: string; code: string; name: string; template_kind: string; kind_label: string; asset_class: string | null; current_version_id: string | null; is_active: boolean }
const UUID = /^[0-9a-f-]{36}$/i;

export async function loadProgramScreen(id: string, versionParam: string | undefined): Promise<{ template: TemplateHead; program: LoadedProgram | null; versionQuery: string; wantedVersion: string | null }> {
  if (!UUID.test(id)) notFound();
  const wantedVersion = typeof versionParam === 'string' && UUID.test(versionParam) ? versionParam : null;
  const template = (await query<TemplateHead>(`
    SELECT t.id, t.code, t.name, t.template_kind, COALESCE(k.label, t.template_kind) AS kind_label, ac.code AS asset_class, t.current_version_id, t.is_active
      FROM session_templates t LEFT JOIN template_kinds k ON k.code = t.template_kind LEFT JOIN asset_classes ac ON ac.id = t.asset_class_id
     WHERE t.id = $1::uuid AND t.deleted_at IS NULL`, [id]))[0] ?? null;
  if (!template) notFound();
  const versionId = wantedVersion ?? template.current_version_id;
  const program = versionId ? await loadProgramVersion(versionId) : null;
  if (program && program.version.template_id !== template.id) notFound();
  return { template, program, versionQuery: wantedVersion ? `?version=${wantedVersion}` : '', wantedVersion };
}
