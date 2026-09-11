import 'server-only';
import type { PoolClient } from 'pg';
import { transaction } from '@/lib/db';
import { policy } from '@/lib/config';
import { audit, type AuditActor, type RequestContext } from '@/lib/audit';
import { serialiseSectionContent, serialiseTaskContent, parseSectionContent, parseTaskContent, SETUP_KINDS, type ProgramVocab, type TaskContent } from './shape';
import { programVocab } from './index';

/**
 * lib/program/write.ts - the builder's write path into template_elements.
 *
 * Every change is one transaction: lock the version, refuse unless it is a draft, do the change,
 * write one audit row. The published-version trigger (0021) would refuse anyway; checking here
 * turns a constraint name into a sentence.
 *
 * KEYS ARE MINTED ONCE AND NEVER CHANGE. An element_key is derived from the title under its
 * parent at creation, made unique within the version, and kept through every rename and move:
 * grades point at it. Renaming changes the title only.
 *
 * Positions are renumbered contiguously per parent after every structural change, so `position`
 * is always 0..n-1 among siblings and a move is a swap of two adjacent rows.
 */

const KEY_MAX = 63;

export class WriteRefused extends Error {}

interface VersionLock { id: string; template_id: string; status: string; version: number }

async function lockDraft(client: PoolClient, versionId: string): Promise<VersionLock> {
  const r = await client.query<VersionLock>(
    `SELECT id, template_id, status, version FROM session_template_versions WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`, [versionId]);
  const v = r.rows[0];
  if (!v) throw new WriteRefused('No such version.');
  if (v.status !== 'draft') throw new WriteRefused(`Version ${v.version} is ${v.status} and immutable. Clone it to a new draft to change it.`);
  return v;
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

async function mintKey(client: PoolClient, versionId: string, parentKey: string | null, title: string): Promise<string> {
  const pattern = new RegExp(policy().templates?.element_key_pattern ?? '^[a-z0-9][a-z0-9_.-]{0,62}$');
  const prefix = parentKey ? `${parentKey}.` : '';
  const room = Math.max(8, KEY_MAX - prefix.length - 3);
  const base = `${prefix}${slug(title).slice(0, room)}`.replace(/-+$/, '');
  const taken = new Set((await client.query<{ element_key: string }>(`SELECT element_key FROM template_elements WHERE template_version_id = $1::uuid`, [versionId])).rows.map((r) => r.element_key));
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  if (!pattern.test(key)) throw new WriteRefused(`Could not make a valid key from "${title}".`);
  return key;
}

function refuseReserved(title: string): void {
  const reserved = new Set((policy().reserved_element_titles ?? []).map((t) => t.trim().toLowerCase()));
  if (reserved.has(title.trim().toLowerCase())) {
    throw new WriteRefused(`"${title}" is a title the renderer owns (subjects, competencies, outcome, remarks, signatures); a section with that title would print twice.`);
  }
}

async function requireParentSection(client: PoolClient, versionId: string, parentKey: string | null): Promise<void> {
  if (parentKey === null) return;
  const r = await client.query<{ element_type: string }>(`SELECT element_type FROM template_elements WHERE template_version_id = $1::uuid AND element_key = $2`, [versionId, parentKey]);
  const p = r.rows[0];
  if (!p) throw new WriteRefused('The chosen section no longer exists.');
  if (p.element_type !== 'section' && p.element_type !== 'group') throw new WriteRefused('Elements can only be placed inside a section.');
}

async function nextPosition(client: PoolClient, versionId: string, parentKey: string | null): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT COALESCE(max(position), -1) + 1 AS n FROM template_elements WHERE template_version_id = $1::uuid AND parent_key IS NOT DISTINCT FROM $2`, [versionId, parentKey]);
  return r.rows[0]?.n ?? 0;
}

async function renumber(client: PoolClient, versionId: string, parentKey: string | null): Promise<void> {
  await client.query(
    `WITH ordered AS (
       SELECT id, row_number() OVER (ORDER BY position, element_key) - 1 AS pos
         FROM template_elements WHERE template_version_id = $1::uuid AND parent_key IS NOT DISTINCT FROM $2)
     UPDATE template_elements e SET position = o.pos FROM ordered o WHERE o.id = e.id AND e.position <> o.pos`,
    [versionId, parentKey]);
}

async function bumpVersion(client: PoolClient, versionId: string): Promise<void> {
  await client.query(`UPDATE session_template_versions SET updated_at = now() WHERE id = $1::uuid`, [versionId]);
}

export interface WriteContext { actor: AuditActor; request: RequestContext }

/* ------------------------------------------------------------------ */

export async function addSection(versionId: string, input: { parentKey: string | null; title: string; sectionKind: string | null; phase: string | null; minutes: number | null; trainingOnly: boolean }, ctx: WriteContext): Promise<string> {
  const vocab: ProgramVocab = programVocab();
  const title = input.title.trim();
  if (title.length < 2) throw new WriteRefused('A section needs a title.');
  refuseReserved(title);
  const parsed = parseSectionContent({ section_kind: input.sectionKind, phase: input.phase, time: input.minutes, training_only: input.trainingOnly }, vocab);
  if (parsed.problems.length) throw new WriteRefused(parsed.problems.map((p) => `${p.path}: ${p.message}`).join('; '));
  return transaction(async (client) => {
    const v = await lockDraft(client, versionId);
    await requireParentSection(client, versionId, input.parentKey);
    const key = await mintKey(client, versionId, input.parentKey, title);
    const position = await nextPosition(client, versionId, input.parentKey);
    await client.query(
      `INSERT INTO template_elements (template_version_id, element_key, parent_key, element_type, title, position, is_graded, content)
       VALUES ($1::uuid, $2, $3, 'section', $4, $5, false, $6::jsonb)`,
      [versionId, key, input.parentKey, title, position, JSON.stringify(serialiseSectionContent(parsed.value))]);
    await bumpVersion(client, versionId);
    await audit({ action: 'template.element.add', entityTable: 'template_elements', entityId: key, capabilityCode: 'training.templates.configure',
      details: { version_id: versionId, template_id: v.template_id, element_type: 'section', parent_key: input.parentKey, title, phase: parsed.value.phase } }, ctx.actor, ctx.request, client);
    return key;
  });
}

/** A blank element of a given type under a section. Tasks start with empty content; the inspector fills them. */
export async function addBlank(versionId: string, input: { parentKey: string; elementType: 'task' | 'setup' | 'event_option' | 'note'; title: string }, ctx: WriteContext): Promise<string> {
  const title = input.title.trim();
  if (title.length < 2) throw new WriteRefused('An element needs a title.');
  refuseReserved(title);
  const content = input.elementType === 'task' ? serialiseTaskContent(parseTaskContent({}, programVocab()).value) : input.elementType === 'note' ? { text: title } : {};
  return transaction(async (client) => {
    const v = await lockDraft(client, versionId);
    await requireParentSection(client, versionId, input.parentKey);
    const key = await mintKey(client, versionId, input.parentKey, title);
    const position = await nextPosition(client, versionId, input.parentKey);
    await client.query(
      `INSERT INTO template_elements (template_version_id, element_key, parent_key, element_type, title, position, is_graded, content)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [versionId, key, input.parentKey, input.elementType, title, position, input.elementType === 'task', JSON.stringify(content)]);
    await bumpVersion(client, versionId);
    await audit({ action: 'template.element.add', entityTable: 'template_elements', entityId: key, capabilityCode: 'training.templates.configure',
      details: { version_id: versionId, template_id: v.template_id, element_type: input.elementType, parent_key: input.parentKey, title } }, ctx.actor, ctx.request, client);
    return key;
  });
}

/**
 * Places a library element under a section. The content is COPIED (docs/05 section 1: a library
 * edit must never change a template already authored); provenance is kept in content.from_library
 * for the badge and nothing else. A library `section` (a block preset) is placed with its own
 * children, if it carries any in content.children.
 */
export async function addFromLibrary(versionId: string, input: { parentKey: string; libraryCode: string }, ctx: WriteContext): Promise<string> {
  interface Lib { id: string; code: string; element_type: string; title: string | null; content: Record<string, unknown>; tags: string[] }
  return transaction(async (client) => {
    const v = await lockDraft(client, versionId);
    await requireParentSection(client, versionId, input.parentKey);
    const lib = (await client.query<Lib>(`SELECT id, code, element_type, title, content, tags FROM element_library WHERE code = $1 AND deleted_at IS NULL AND is_active`, [input.libraryCode])).rows[0];
    if (!lib) throw new WriteRefused('That library element does not exist or is retired.');
    const type = lib.element_type === 'reset' ? 'setup' : lib.element_type === 'malfunction' ? 'event_option' : lib.element_type === 'text' ? 'note' : lib.element_type;
    if (!['section', 'task', 'setup', 'event_option', 'note', 'field', 'computed', 'group'].includes(type)) throw new WriteRefused(`Library type ${lib.element_type} cannot be placed.`);
    const title = lib.title ?? lib.code;
    const key = await mintKey(client, versionId, input.parentKey, title);
    const position = await nextPosition(client, versionId, input.parentKey);
    const { children, ...own } = lib.content as { children?: unknown[] } & Record<string, unknown>;
    const content = { ...own, from_library: lib.code };
    await client.query(
      `INSERT INTO template_elements (template_version_id, element_key, parent_key, element_type, title, position, is_graded, content)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [versionId, key, input.parentKey, type, title, position, type === 'task', JSON.stringify(content)]);
    // A preset carries children: place them beneath, in order.
    if (type === 'section' && Array.isArray(children)) {
      let pos = 0;
      for (const c of children) {
        if (!c || typeof c !== 'object') continue;
        const child = c as { element_type?: string; title?: string; content?: Record<string, unknown> };
        const ct = child.element_type && ['task', 'setup', 'event_option', 'note'].includes(child.element_type) ? child.element_type : 'task';
        const ctitle = child.title ?? ct;
        const ckey = await mintKey(client, versionId, key, ctitle);
        // A child that names a library element takes that element's content, so a preset is a
        // list of references and the task text lives once, in the library.
        const ref = typeof child.content?.from_library === 'string' ? child.content.from_library : null;
        const refRow = ref ? (await client.query<Lib>(`SELECT id, code, element_type, title, content, tags FROM element_library WHERE code = $1 AND deleted_at IS NULL AND is_active`, [ref])).rows[0] : undefined;
        const ccontent = refRow ? { ...refRow.content, from_library: refRow.code } : { ...(child.content ?? {}), from_library: lib.code };
        await client.query(
          `INSERT INTO template_elements (template_version_id, element_key, parent_key, element_type, title, position, is_graded, content)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [versionId, ckey, key, ct, refRow?.title ?? ctitle, pos, ct === 'task', JSON.stringify(ccontent)]);
        pos += 1;
      }
    }
    await bumpVersion(client, versionId);
    await audit({ action: 'template.element.add', entityTable: 'template_elements', entityId: key, capabilityCode: 'training.templates.configure',
      details: { version_id: versionId, template_id: v.template_id, element_type: type, parent_key: input.parentKey, title, from_library: lib.code } }, ctx.actor, ctx.request, client);
    return key;
  });
}

export async function moveElement(versionId: string, key: string, direction: 'up' | 'down', ctx: WriteContext): Promise<void> {
  await transaction(async (client) => {
    const v = await lockDraft(client, versionId);
    const me = (await client.query<{ parent_key: string | null; position: number }>(`SELECT parent_key, position FROM template_elements WHERE template_version_id = $1::uuid AND element_key = $2`, [versionId, key])).rows[0];
    if (!me) throw new WriteRefused('No such element.');
    await renumber(client, versionId, me.parent_key);
    const cur = (await client.query<{ position: number }>(`SELECT position FROM template_elements WHERE template_version_id = $1::uuid AND element_key = $2`, [versionId, key])).rows[0]?.position ?? 0;
    const target = direction === 'up' ? cur - 1 : cur + 1;
    const other = (await client.query<{ element_key: string }>(
      `SELECT element_key FROM template_elements WHERE template_version_id = $1::uuid AND parent_key IS NOT DISTINCT FROM $2 AND position = $3`, [versionId, me.parent_key, target])).rows[0];
    if (!other) return;                                   // already at the edge: nothing to do, not an error
    await client.query(`UPDATE template_elements SET position = $3 WHERE template_version_id = $1::uuid AND element_key = $2`, [versionId, other.element_key, cur]);
    await client.query(`UPDATE template_elements SET position = $3 WHERE template_version_id = $1::uuid AND element_key = $2`, [versionId, key, target]);
    await bumpVersion(client, versionId);
    await audit({ action: 'template.element.move', entityTable: 'template_elements', entityId: key, capabilityCode: 'training.templates.configure',
      details: { version_id: versionId, template_id: v.template_id, direction, from: cur, to: target } }, ctx.actor, ctx.request, client);
  });
}

export async function renameElement(versionId: string, key: string, title: string, ctx: WriteContext): Promise<void> {
  const t = title.trim();
  if (t.length < 2) throw new WriteRefused('A title is required.');
  refuseReserved(t);
  await transaction(async (client) => {
    const v = await lockDraft(client, versionId);
    const r = await client.query<{ title: string | null }>(`UPDATE template_elements SET title = $3 WHERE template_version_id = $1::uuid AND element_key = $2 RETURNING title`, [versionId, key, t]);
    if (!r.rows.length) throw new WriteRefused('No such element.');
    await bumpVersion(client, versionId);
    await audit({ action: 'template.element.rename', entityTable: 'template_elements', entityId: key, capabilityCode: 'training.templates.configure',
      details: { version_id: versionId, template_id: v.template_id, title: t } }, ctx.actor, ctx.request, client);
  });
}

/** Removes an element and everything beneath it. Draft only; the count of what went is in the audit row. */
export async function removeElement(versionId: string, key: string, ctx: WriteContext): Promise<number> {
  return transaction(async (client) => {
    const v = await lockDraft(client, versionId);
    const me = (await client.query<{ parent_key: string | null }>(`SELECT parent_key FROM template_elements WHERE template_version_id = $1::uuid AND element_key = $2`, [versionId, key])).rows[0];
    if (!me) throw new WriteRefused('No such element.');
    const r = await client.query(
      `WITH RECURSIVE sub AS (
         SELECT element_key FROM template_elements WHERE template_version_id = $1::uuid AND element_key = $2
         UNION ALL
         SELECT e.element_key FROM template_elements e JOIN sub ON e.parent_key = sub.element_key WHERE e.template_version_id = $1::uuid)
       DELETE FROM template_elements WHERE template_version_id = $1::uuid AND element_key IN (SELECT element_key FROM sub)`,
      [versionId, key]);
    await renumber(client, versionId, me.parent_key);
    await bumpVersion(client, versionId);
    const n = r.rowCount ?? 0;
    await audit({ action: 'template.element.remove', entityTable: 'template_elements', entityId: key, capabilityCode: 'training.templates.configure',
      details: { version_id: versionId, template_id: v.template_id, removed: n } }, ctx.actor, ctx.request, client);
    return n;
  });
}

/** The section's own fields: kind, phase, time, training-only. Title is renameElement; the key never changes. */
export async function updateSection(versionId: string, key: string, input: { sectionKind: string | null; phase: string | null; minutes: number | null; trainingOnly: boolean }, ctx: WriteContext): Promise<void> {
  const parsed = parseSectionContent({ section_kind: input.sectionKind, phase: input.phase, time: input.minutes, training_only: input.trainingOnly }, programVocab());
  if (parsed.problems.length) throw new WriteRefused(parsed.problems.map((p) => `${p.path}: ${p.message}`).join('; '));
  await transaction(async (client) => {
    const v = await lockDraft(client, versionId);
    const cur = (await client.query<{ element_type: string; content: Record<string, unknown> }>(`SELECT element_type, content FROM template_elements WHERE template_version_id = $1::uuid AND element_key = $2`, [versionId, key])).rows[0];
    if (!cur) throw new WriteRefused('No such element.');
    if (cur.element_type !== 'section') throw new WriteRefused('Only a section carries a phase.');
    const next = { ...cur.content, ...serialiseSectionContent({ ...parsed.value, aims: parseSectionContent(cur.content, programVocab()).value.aims, from_preset: parseSectionContent(cur.content, programVocab()).value.from_preset }) };
    await client.query(`UPDATE template_elements SET content = $3::jsonb WHERE template_version_id = $1::uuid AND element_key = $2`, [versionId, key, JSON.stringify(next)]);
    await bumpVersion(client, versionId);
    await audit({ action: 'template.element.update', entityTable: 'template_elements', entityId: key, capabilityCode: 'training.templates.configure',
      details: { version_id: versionId, template_id: v.template_id, section_kind: parsed.value.section_kind, phase: parsed.value.phase, minutes: parsed.value.minutes, training_only: parsed.value.training_only } }, ctx.actor, ctx.request, client);
  });
}

/* ------------------------------------------------------------------ */
/* Task content - the inspector's four tabs                             */
/* ------------------------------------------------------------------ */

export type TaskTab = 'setup' | 'conduct' | 'assessment' | 'aims';

/**
 * Applies one tab's form to a task. The current content is parsed, the tab's keys are replaced
 * from the form, the result is serialised in canonical form and saved. Keys the tab does not own
 * are untouched, so saving Set-up never disturbs Conduct. Refused with the parser's problems when
 * a value is not valid - the form redisplays with the message, nothing is half-written.
 */
export async function updateTask(versionId: string, key: string, tab: TaskTab, form: (k: string) => string, formAll: (k: string) => string[], ctx: WriteContext): Promise<void> {
  const vocab = programVocab();
  const ref = (k: string) => { const r = form(`${k}_ref`); const o = form(`${k}_override`); return r ? { ref: r, override: o || null } : null; };
  await transaction(async (client) => {
    const v = await lockDraft(client, versionId);
    const cur = (await client.query<{ element_type: string; content: Record<string, unknown> }>(`SELECT element_type, content FROM template_elements WHERE template_version_id = $1::uuid AND element_key = $2`, [versionId, key])).rows[0];
    if (!cur) throw new WriteRefused('No such element.');
    if (cur.element_type !== 'task') throw new WriteRefused('Only a task carries set-up, conduct, assessment and aims.');
    const now = parseTaskContent(cur.content, vocab).value;
    let next: TaskContent;
    switch (tab) {
      case 'setup':
        next = { ...now, setup: Object.fromEntries(SETUP_KINDS.map((k) => [k, ref(k)])) as TaskContent['setup'] };
        break;
      case 'conduct': {
        const slotGroup = form('slot_group');
        next = { ...now,
          automation: { ap: form('ap') as TaskContent['automation']['ap'], athr: form('athr') as TaskContent['automation']['athr'], fd: form('fd') as TaskContent['automation']['fd'] },
          conduct: {
            malfunction: slotGroup ? null : ref('malfunction'),
            slot: slotGroup ? { group: slotGroup, policy: form('slot_policy') as NonNullable<TaskContent['conduct']['slot']>['policy'], no_repeat_within_modules: form('slot_no_repeat') ? Number(form('slot_no_repeat')) : null, cycle_coverage: form('slot_cycle') === 'on' } : null,
            insertion: form('insertion') || null,
            injects: formAll('injects').filter(Boolean).map((r) => ({ ref: r, override: null })),
            instructor_notes: form('instructor_notes') || null,
          } };
        break;
      }
      case 'assessment':
        next = { ...now,
          minutes: form('time') ? (parseMinutesOrThrow(form('time'))) : null,
          pf: form('pf') || null,
          snapshot: (form('snapshot') || null) as TaskContent['snapshot'],
          grading: { task_outcome_mode: form('task_outcome_mode') as TaskContent['grading']['task_outcome_mode'], competency_grade_mode: form('competency_grade_mode') as TaskContent['grading']['competency_grade_mode'], competencies: formAll('competencies').filter(Boolean) } };
        break;
      case 'aims':
        next = { ...now, aims: { aims: form('aims') || null, competency_focus: form('competency_focus') || null, grading_criteria: form('grading_criteria') || null, visibility: (form('visibility') || 'instructor_only') as TaskContent['aims']['visibility'] } };
        break;
    }
    // Round-trip through the parser: every enum and reference is checked the same way a read is.
    const check = parseTaskContent(serialiseTaskContent(next), vocab);
    if (check.problems.length) throw new WriteRefused(check.problems.map((p) => `${p.path}: ${p.message}`).join('; '));
    const keep = Object.fromEntries(Object.entries(cur.content).filter(([k]) => !['time', 'minutes', 'pf', 'setup', 'conduct', 'automation', 'aims', 'grading', 'snapshot', 'variants'].includes(k)));
    await client.query(`UPDATE template_elements SET content = $3::jsonb, is_graded = $4 WHERE template_version_id = $1::uuid AND element_key = $2`,
      [versionId, key, JSON.stringify({ ...keep, ...serialiseTaskContent(check.value) }), check.value.grading.task_outcome_mode !== 'none' || check.value.grading.competency_grade_mode !== 'none']);
    await bumpVersion(client, versionId);
    await audit({ action: 'template.element.update', entityTable: 'template_elements', entityId: key, capabilityCode: 'training.templates.configure',
      details: { version_id: versionId, template_id: v.template_id, tab } }, ctx.actor, ctx.request, client);
  });
}

function parseMinutesOrThrow(s: string): number {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(s.trim());
  if (!m) throw new WriteRefused('Time must read like 0:45.');
  return Number(m[1]) * 60 + Number(m[2]);
}
