import { NextResponse, type NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { actorFromSession, requestContext } from '@/lib/audit';
import { flashCookie } from '@/lib/admin';
import { parseMinutes } from '@/lib/program/shape';
import { addBlank, addFromLibrary, addSection, moveElement, removeElement, renameElement, updateSection, updateTask, WriteRefused, type TaskTab } from '@/lib/program/write';

/**
 * POST /api/templates/[id]/elements - structural changes to the current draft. `_action`:
 *
 *   add_section    parent (key or ''), title, section_kind, phase, time, training_only
 *   add_blank      parent, element_type (task|setup|event_option|note), title
 *   add_library    parent, code
 *   move           key, direction (up|down)
 *   rename         key, title
 *   set_section    key, section_kind, phase, time, training_only
 *   set_task       key, tab (setup|conduct|assessment|aims) + that tab's fields
 *   remove         key
 *
 * Every action redirects back to the builder with the changed element selected, and the message
 * in the flash. Gate: training.templates.configure. The version is the template's CURRENT one
 * unless `version` names another draft of the same template.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const KEY = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.configure');

  const form = await request.formData();
  const str = (k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
  const action = str('_action', 20);
  const requested = str('version', 40);
  const ctx = { actor: actorFromSession(session), request: requestContext(request.headers) };

  const versionRow = (await query<{ id: string }>(
    requested && UUID.test(requested)
      ? `SELECT id FROM session_template_versions WHERE id = $2::uuid AND template_id = $1::uuid AND deleted_at IS NULL`
      : `SELECT current_version_id AS id FROM session_templates WHERE id = $1::uuid AND deleted_at IS NULL`,
    requested && UUID.test(requested) ? [id, requested] : [id]))[0];
  const versionId = versionRow?.id ?? null;

  const back = (flash: Parameters<typeof flashCookie>[0], sel: string | null, tab: string | null = null) => {
    const url = new URL(`/templates/${id}`, request.nextUrl.origin);
    if (requested) url.searchParams.set('version', requested);
    if (sel) url.searchParams.set('sel', sel);
    if (tab) url.searchParams.set('tab', tab);
    const res = NextResponse.redirect(url, 303);
    res.cookies.set(flashCookie(flash, '/templates'));
    return res;
  };

  if (!versionId) return back({ kind: 'bad', message: 'This program has no version to edit.' }, null);

  const parent = str('parent', 63);
  const key = str('key', 63);
  const title = str('title', 200);
  if (parent && !KEY.test(parent)) return back({ kind: 'bad', message: 'Bad parent key.' }, null);
  if (key && !KEY.test(key)) return back({ kind: 'bad', message: 'Bad element key.' }, null);

  try {
    switch (action) {
      case 'add_section': {
        const timeRaw = str('time', 10);
        const minutes = timeRaw ? parseMinutes(timeRaw) : null;
        if (timeRaw && minutes === null) throw new WriteRefused('Time must read like 0:50.');
        const k = await addSection(versionId, { parentKey: parent || null, title, sectionKind: str('section_kind', 20) || null, phase: str('phase', 20) || null, minutes, trainingOnly: str('training_only', 5) === 'on' }, ctx);
        return back({ kind: 'ok', message: `Section "${title}" added.` }, k);
      }
      case 'add_blank': {
        const type = str('element_type', 20);
        if (type !== 'task' && type !== 'setup' && type !== 'event_option' && type !== 'note') throw new WriteRefused('Choose an element type.');
        if (!parent) throw new WriteRefused('Choose the section to add it to.');
        const k = await addBlank(versionId, { parentKey: parent, elementType: type, title }, ctx);
        return back({ kind: 'ok', message: `"${title}" added.` }, k);
      }
      case 'add_library': {
        if (!parent) throw new WriteRefused('Select a section first, then add from the library.');
        const code = str('code', 63);
        if (!KEY.test(code)) throw new WriteRefused('Bad library code.');
        const k = await addFromLibrary(versionId, { parentKey: parent, libraryCode: code }, ctx);
        return back({ kind: 'ok', message: `Placed from the library.` }, k);
      }
      case 'move': {
        const direction = str('direction', 5);
        if (!key || (direction !== 'up' && direction !== 'down')) throw new WriteRefused('Bad move.');
        await moveElement(versionId, key, direction, ctx);
        return back({ kind: 'ok', message: `Moved ${direction}.` }, key);
      }
      case 'rename': {
        if (!key) throw new WriteRefused('No element.');
        await renameElement(versionId, key, title, ctx);
        return back({ kind: 'ok', message: 'Title saved.' }, key);
      }
      case 'set_section': {
        if (!key) throw new WriteRefused('No element.');
        const timeRaw = str('time', 10);
        const minutes = timeRaw ? parseMinutes(timeRaw) : null;
        if (timeRaw && minutes === null) throw new WriteRefused('Time must read like 0:50.');
        await updateSection(versionId, key, { sectionKind: str('section_kind', 20) || null, phase: str('phase', 20) || null, minutes, trainingOnly: str('training_only', 5) === 'on' }, ctx);
        return back({ kind: 'ok', message: 'Section saved.' }, key);
      }
      case 'set_task': {
        if (!key) throw new WriteRefused('No element.');
        const tab = str('tab', 12);
        if (tab !== 'setup' && tab !== 'conduct' && tab !== 'assessment' && tab !== 'aims') throw new WriteRefused('Unknown tab.');
        const all = (k: string) => form.getAll(k).map((v) => String(v).trim().slice(0, 200));
        await updateTask(versionId, key, tab as TaskTab, (k) => str(k, 4000), all, ctx);
        return back({ kind: 'ok', message: `${tab[0]?.toUpperCase()}${tab.slice(1)} saved.` }, key, tab);
      }
      case 'remove': {
        if (!key) throw new WriteRefused('No element.');
        const n = await removeElement(versionId, key, ctx);
        return back({ kind: 'ok', message: n === 1 ? 'Element removed.' : `Removed ${n} elements.` }, null);
      }
      default:
        return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
    }
  } catch (err) {
    const tab = str('tab', 12) || null;
    return back({ kind: 'bad', message: err instanceof Error ? err.message : 'The change was not made.' }, key || null, tab);
  }
}
