import 'server-only';
import { query, transaction } from '@/lib/db';
import { audit, type AuditActor, type RequestContext } from '@/lib/audit';

/**
 * lib/program/library.ts - the element library as the builder's rail sees it.
 *
 * A library row is an element_library record; its KIND is a tag (migration 0144 documents the
 * set), its fleet a `fleet:<code>` tag. Kinds are grouped for the rail in a fixed order that
 * matches how an author thinks: the things you place (tasks, blocks), then the things you attach
 * to a task (malfunctions, injects), then the set-up conditions.
 */

export const LIBRARY_KINDS = [
  { tag: 'task',        label: 'Tasks',        element_type: 'task',         placeable: true },
  { tag: 'block',       label: 'Blocks',       element_type: 'section',      placeable: true },
  { tag: 'malfunction', label: 'Malfunctions', element_type: 'event_option', placeable: true },
  { tag: 'inject',      label: 'Injects',      element_type: 'event_option', placeable: true },
  { tag: 'airport',     label: 'Airports',     element_type: 'setup',        placeable: false },
  { tag: 'weather',     label: 'Weather',      element_type: 'setup',        placeable: false },
  { tag: 'mass_config', label: 'Mass & config', element_type: 'setup',       placeable: false },
  { tag: 'position',    label: 'Positions',    element_type: 'setup',        placeable: false },
  { tag: 'comms',       label: 'Comms',        element_type: 'setup',        placeable: false },
  { tag: 'reset',       label: 'Resets',       element_type: 'setup',        placeable: true },
  { tag: 'atc_script',  label: 'ATC scripts',  element_type: 'setup',        placeable: false },
  { tag: 'note',        label: 'Notes',        element_type: 'note',         placeable: true },
] as const;

export type LibraryKindTag = (typeof LIBRARY_KINDS)[number]['tag'];

export function isLibraryKind(tag: string): tag is LibraryKindTag {
  return LIBRARY_KINDS.some((k) => k.tag === tag);
}

export interface LibraryRow {
  id: string;
  code: string;
  element_type: string;
  title: string;
  kind: string | null;
  fleet: string | null;
  summary: string | null;
  tags: string[];
}

/** The rail: every active library element, optionally narrowed by search and fleet. */
export async function listLibrary(opts: { q?: string; fleet?: string | null }): Promise<LibraryRow[]> {
  const params: unknown[] = [];
  const where = ['l.deleted_at IS NULL', 'l.is_active'];
  if (opts.q) { params.push(`%${opts.q}%`); where.push(`(l.title ILIKE $${params.length} OR l.code ILIKE $${params.length} OR l.content->>'summary' ILIKE $${params.length})`); }
  if (opts.fleet) { params.push(`fleet:${opts.fleet}`); where.push(`(NOT EXISTS (SELECT 1 FROM unnest(l.tags) t WHERE t LIKE 'fleet:%') OR $${params.length} = ANY (l.tags))`); }
  return query<LibraryRow>(`
    SELECT l.id, l.code, l.element_type, COALESCE(l.title, l.code) AS title,
           (SELECT t FROM unnest(l.tags) t WHERE t IN (${LIBRARY_KINDS.map((k) => `'${k.tag}'`).join(',')}) LIMIT 1) AS kind,
           (SELECT substr(t, 7) FROM unnest(l.tags) t WHERE t LIKE 'fleet:%' LIMIT 1) AS fleet,
           l.content->>'summary' AS summary, l.tags
      FROM element_library l
     WHERE ${where.join(' AND ')}
     ORDER BY l.title, l.code
     LIMIT 400`, params);
}

export interface LibraryCreate {
  kind: LibraryKindTag;
  title: string;
  code: string | null;
  fleet: string | null;
  summary: string | null;
  /** Free text the kind stores: a malfunction's IOS name and trigger, a weather string, an ATC line. */
  text: string | null;
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Creates one library element by hand. The malfunction reference ingestion, when it lands, writes the same rows. */
export async function createLibraryElement(input: LibraryCreate, actor: AuditActor, request: RequestContext): Promise<string> {
  const kind = LIBRARY_KINDS.find((k) => k.tag === input.kind);
  if (!kind) throw new Error('Choose a library kind.');
  const title = input.title.trim();
  if (title.length < 2) throw new Error('A title is required.');
  const code = (input.code?.trim() || `${kind.tag}.${slug(title)}`).slice(0, 63);
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(code)) throw new Error('The code must be lowercase letters, digits, dot, dash or underscore.');
  const tags = [kind.tag, ...(input.fleet ? [`fleet:${input.fleet}`] : [])];
  const content: Record<string, unknown> = { summary: input.summary?.trim() || null };
  switch (kind.element_type) {
    case 'event_option': content.options = [{ key: slug(title).slice(0, 40) || 'option', name: title, trigger: input.text?.trim() || null }]; break;
    case 'setup': content.rows = [{ label: kind.label.replace(/s$/, ''), value: input.text?.trim() || title }]; break;
    case 'note': content.text = input.text?.trim() || title; break;
    case 'task': content.time = null; content.aims = { aims: input.text?.trim() || null }; break;
    case 'section': content.section_kind = 'block'; content.children = []; break;
  }
  return transaction(async (client) => {
    const dup = await client.query(`SELECT 1 FROM element_library WHERE code = $1 AND deleted_at IS NULL`, [code]);
    if (dup.rows.length) throw new Error(`A library element with code ${code} already exists.`);
    const r = await client.query<{ id: string }>(
      `INSERT INTO element_library (code, element_type, title, tags, content, created_by) VALUES ($1, $2, $3, $4::text[], $5::jsonb, $6::uuid) RETURNING id`,
      [code, kind.element_type, title, tags, JSON.stringify(content), actor.userId]);
    await audit({ action: 'library.create', entityTable: 'element_library', entityId: r.rows[0]?.id ?? code, capabilityCode: 'training.library.manage',
      details: { code, kind: kind.tag, element_type: kind.element_type, title, fleet: input.fleet } }, actor, request, client);
    return code;
  });
}

/* ------------------------------------------------------------------ */
/* Pickers - what the inspector offers                                  */
/* ------------------------------------------------------------------ */

export interface PickOption { code: string; title: string; group: string | null }

/** Library elements of one kind tag, for a select. Malfunctions group by ATA chapter. */
export async function pickList(kind: LibraryKindTag, fleet: string | null): Promise<PickOption[]> {
  const params: unknown[] = [kind];
  let fleetClause = '';
  if (fleet) { params.push(`fleet:${fleet}`); fleetClause = `AND (NOT EXISTS (SELECT 1 FROM unnest(l.tags) t WHERE t LIKE 'fleet:%') OR $2 = ANY (l.tags))`; }
  return query<PickOption>(`
    SELECT l.code, COALESCE(l.title, l.code) AS title,
           CASE WHEN l.content->'ios'->>'ata' IS NOT NULL THEN 'ATA ' || (l.content->'ios'->>'ata') || ' · ' || COALESCE(l.content->'ios'->>'ata_label', '') ELSE NULL END AS "group"
      FROM element_library l
     WHERE l.deleted_at IS NULL AND l.is_active AND $1 = ANY (l.tags) ${fleetClause}
     ORDER BY 3 NULLS FIRST, 2`, params);
}

export interface GroupOption { code: string; name: string; candidates: number }

export async function equivalencyGroups(fleet: string | null): Promise<GroupOption[]> {
  const params: unknown[] = [];
  let fleetClause = '';
  if (fleet) { params.push(fleet); fleetClause = `AND (g.asset_class_id IS NULL OR g.asset_class_id = (SELECT id FROM asset_classes WHERE code = $1 AND deleted_at IS NULL))`; }
  return query<GroupOption>(`
    SELECT g.code, g.name, (SELECT count(*)::int FROM equivalency_group_candidates c WHERE c.group_id = g.id AND c.is_active) AS candidates
      FROM equivalency_groups g WHERE g.deleted_at IS NULL AND g.is_active ${fleetClause} ORDER BY g.name`, params);
}
