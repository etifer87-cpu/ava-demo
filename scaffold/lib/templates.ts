import 'server-only';
import { query } from './db';
import { foldedLikeAny } from './search';

/**
 * lib/templates.ts - the program list and its options. docs/06_PROGRAM_BUILDER.md section 5.1.
 *
 * A "program" on screen is a session_templates row with its CURRENT version. The list query joins
 * the version, the kind label from the template_kinds catalogue (0032), the fleet, and two counts
 * that the list shows so nobody has to open a row to learn whether it is empty: elements and
 * competencies targeted. Filtering is SQL, driven by the GET form, so every filtered view is a URL.
 */

export interface ProgramRow {
  id: string;
  code: string;
  name: string;
  template_kind: string;
  kind_label: string;
  asset_class: string | null;
  is_active: boolean;
  version_id: string | null;
  version: number | null;
  status: string | null;
  effective_from: string | null;
  element_count: number;
  task_count: number;
  competency_count: number;
  program_code: string | null;
  program_module: string | null;
  program_year: number | null;
  program_day: number | null;
  updated_at: string;
  updated_by: string | null;
}

export async function listPrograms(opts: { q?: string; kind?: string; fleet?: string; status?: string }): Promise<ProgramRow[]> {
  const where: string[] = ['t.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts.q) { params.push(`%${opts.q}%`); where.push(`(${foldedLikeAny(['t.name', 't.code', "v.setup->'program'->>'code'", "v.setup->'program'->>'module'"], `$${params.length}`)})`); }
  if (opts.kind) { params.push(opts.kind); where.push(`t.template_kind = $${params.length}`); }
  if (opts.fleet) { params.push(opts.fleet); where.push(`ac.code = $${params.length}`); }
  if (opts.status === 'draft' || opts.status === 'published' || opts.status === 'retired') { params.push(opts.status); where.push(`v.status = $${params.length}`); }
  if (opts.status === 'inactive') where.push('NOT t.is_active'); else if (opts.status !== 'any') where.push('t.is_active');

  return query<ProgramRow>(`
    SELECT t.id, t.code, t.name, t.template_kind, COALESCE(k.label, t.template_kind) AS kind_label,
           ac.code AS asset_class, t.is_active,
           v.id AS version_id, v.version, v.status, v.effective_from::text,
           (SELECT count(*)::int FROM template_elements e WHERE e.template_version_id = v.id) AS element_count,
           (SELECT count(*)::int FROM template_elements e WHERE e.template_version_id = v.id AND e.element_type = 'task') AS task_count,
           (SELECT count(*)::int FROM template_competencies tc WHERE tc.template_version_id = v.id) AS competency_count,
           v.setup->'program'->>'code' AS program_code,
           v.setup->'program'->>'module' AS program_module,
           NULLIF(v.setup->'program'->>'year', '')::int AS program_year,
           NULLIF(v.setup->'program'->>'day', '')::int AS program_day,
           GREATEST(t.updated_at, COALESCE(v.updated_at, t.updated_at))::text AS updated_at,
           COALESCE(p.full_name, u.username) AS updated_by
      FROM session_templates t
      LEFT JOIN session_template_versions v ON v.id = t.current_version_id AND v.deleted_at IS NULL
      LEFT JOIN template_kinds k ON k.code = t.template_kind
      LEFT JOIN asset_classes ac ON ac.id = t.asset_class_id
      LEFT JOIN users u ON u.id = t.created_by
      LEFT JOIN people p ON p.id = u.person_id
     WHERE ${where.join(' AND ')}
     ORDER BY v.setup->'program'->>'code' NULLS LAST, NULLIF(v.setup->'program'->>'day', '')::int NULLS LAST, t.name
     LIMIT 500`, params);
}

export interface Option { value: string; label: string }

/** Active template kinds from the catalogue, in position order. The write path re-checks against it. */
export async function kindOptions(): Promise<(Option & { facility_kind: string | null })[]> {
  return query<Option & { facility_kind: string | null }>(`SELECT code AS value, label, facility_kind FROM template_kinds WHERE is_active ORDER BY position, code`);
}

/** Aircraft fleets (not simulators): a program is written for a type, a session is held on a device. */
export async function fleetOptions(): Promise<(Option & { id: string })[]> {
  return query<Option & { id: string }>(`SELECT id, code AS value, name AS label FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'aircraft' ORDER BY position, code`);
}

/** Simulator classes. Not used by the program: the device is chosen when a session (an ETR) is created. */
export async function deviceOptions(): Promise<Option[]> {
  return query<Option>(`SELECT code AS value, name AS label FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'simulator' ORDER BY position, code`);
}

/** A stable code from a name: lowercase, dots for spaces, only the characters element keys allow. */
export function suggestCode(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 63);
}
