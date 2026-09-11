import { NextResponse, type NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { actorFromSession, requestContext } from '@/lib/audit';
import { flashCookie } from '@/lib/admin';
import { parseMinutes } from '@/lib/program/shape';
import { addBlank, addFromLibrary, addSection, isPaletteKind, moveElement, placeElement, removeElement, renameElement, updateContent, updateSection, updateTask, WriteRefused, type TaskTab } from '@/lib/program/write';

/**
 * POST /api/templates/[id]/elements - every change to a draft's structure and content. `_action`:
 *
 *   add            kind (section|exercise|setup|comms|malfunction|event|note), parent, index, title?
 *   add_library    code, parent, index                       a preset or a saved exercise
 *   place          key, parent, index                        the drag gesture
 *   move           key, direction (up|down)                  the keyboard fallback
 *   rename         key, title
 *   remove         key
 *   add_section    parent, title, section_kind, phase, time, training_only     (form fallback)
 *   set_section    key, section_kind, phase, time, training_only
 *   set_task       key, tab (setup|conduct|assessment|aims) + that tab's fields   (form fallback)
 *   set_content    key, content (JSON)                       the inspector panes: whole content, parsed by type
 *
 * Speaks both dialects: a form post is answered with a redirect back to the builder and a flash;
 * a JSON body (the canvas) is answered with JSON `{ ok, key?, message }`. Gate:
 * training.templates.configure. The version is the template's current one unless `version`
 * names another draft of the same template.
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

  // One reader over both bodies.
  const isJson = (request.headers.get('content-type') ?? '').includes('application/json');
  const body: Record<string, unknown> = isJson ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const form = isJson ? null : await request.formData();
  const str = (k: string, max = 200) => {
    const v = form ? form.get(k) : body[k];
    return v === undefined || v === null ? '' : String(v).trim().slice(0, max);
  };
  const all = (k: string) => (form ? form.getAll(k).map((v) => String(v)) : Array.isArray(body[k]) ? (body[k] as unknown[]).map(String) : []).map((v) => v.trim().slice(0, 200));
  const intOrNull = (k: string) => { const v = str(k, 6); if (v === '') return null; const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : null; };

  const action = str('_action', 20);
  const requested = str('version', 40);
  const ctx = { actor: actorFromSession(session), request: requestContext(request.headers) };

  const versionRow = (await query<{ id: string }>(
    requested && UUID.test(requested)
      ? `SELECT id FROM session_template_versions WHERE id = $2::uuid AND template_id = $1::uuid AND deleted_at IS NULL`
      : `SELECT current_version_id AS id FROM session_templates WHERE id = $1::uuid AND deleted_at IS NULL`,
    requested && UUID.test(requested) ? [id, requested] : [id]))[0];
  const versionId = versionRow?.id ?? null;

  const reply = (flash: Parameters<typeof flashCookie>[0], sel: string | null, tab: string | null = null) => {
    if (isJson) return NextResponse.json({ ok: flash.kind !== 'bad', key: sel, message: flash.message }, { status: flash.kind === 'bad' ? 400 : 200 });
    const url = new URL(`/templates/${id}`, request.nextUrl.origin);
    if (requested) url.searchParams.set('version', requested);
    if (sel) url.searchParams.set('sel', sel);
    if (tab) url.searchParams.set('tab', tab);
    const res = NextResponse.redirect(url, 303);
    res.cookies.set(flashCookie(flash, '/templates'));
    return res;
  };

  if (!versionId) return reply({ kind: 'bad', message: 'This program has no version to edit.' }, null);

  const parent = str('parent', 63);
  const key = str('key', 63);
  const title = str('title', 200);
  const index = intOrNull('index');
  if (parent && !KEY.test(parent)) return reply({ kind: 'bad', message: 'Bad parent key.' }, null);
  if (key && !KEY.test(key)) return reply({ kind: 'bad', message: 'Bad element key.' }, null);

  try {
    switch (action) {
      case 'add': {
        const kind = str('kind', 20);
        if (!isPaletteKind(kind)) throw new WriteRefused('Choose what to add.');
        const k = await addBlank(versionId, { parentKey: parent || null, kind, title: title || null, index }, ctx);
        return reply({ kind: 'ok', message: 'Added.' }, k);
      }
      case 'add_library': {
        const code = str('code', 63);
        if (!KEY.test(code)) throw new WriteRefused('Bad library code.');
        const k = await addFromLibrary(versionId, { parentKey: parent || null, libraryCode: code, index }, ctx);
        return reply({ kind: 'ok', message: 'Placed from the library.' }, k);
      }
      case 'place': {
        if (!key) throw new WriteRefused('No element.');
        await placeElement(versionId, key, parent || null, index, ctx);
        return reply({ kind: 'ok', message: 'Moved.' }, key);
      }
      case 'add_section': {
        const timeRaw = str('time', 10);
        const minutes = timeRaw ? parseMinutes(timeRaw) : null;
        if (timeRaw && minutes === null) throw new WriteRefused('Time must read like 0:50.');
        const k = await addSection(versionId, { parentKey: parent || null, title, sectionKind: str('section_kind', 20) || null, phase: str('phase', 20) || null, minutes, trainingOnly: str('training_only', 5) === 'on', index }, ctx);
        return reply({ kind: 'ok', message: `Section "${title}" added.` }, k);
      }
      case 'move': {
        const direction = str('direction', 5);
        if (!key || (direction !== 'up' && direction !== 'down')) throw new WriteRefused('Bad move.');
        await moveElement(versionId, key, direction, ctx);
        return reply({ kind: 'ok', message: `Moved ${direction}.` }, key);
      }
      case 'rename': {
        if (!key) throw new WriteRefused('No element.');
        await renameElement(versionId, key, title, ctx);
        return reply({ kind: 'ok', message: 'Title saved.' }, key);
      }
      case 'set_section': {
        if (!key) throw new WriteRefused('No element.');
        const timeRaw = str('time', 10);
        const minutes = timeRaw ? parseMinutes(timeRaw) : null;
        if (timeRaw && minutes === null) throw new WriteRefused('Time must read like 0:50.');
        await updateSection(versionId, key, { sectionKind: str('section_kind', 20) || null, phase: str('phase', 20) || null, minutes, trainingOnly: str('training_only', 5) === 'on' }, ctx);
        return reply({ kind: 'ok', message: 'Section saved.' }, key);
      }
      case 'set_task': {
        if (!key) throw new WriteRefused('No element.');
        const tab = str('tab', 12);
        if (tab !== 'setup' && tab !== 'conduct' && tab !== 'assessment' && tab !== 'aims') throw new WriteRefused('Unknown tab.');
        await updateTask(versionId, key, tab as TaskTab, (k) => str(k, 4000), all, ctx);
        return reply({ kind: 'ok', message: `${tab[0]?.toUpperCase()}${tab.slice(1)} saved.` }, key, tab);
      }
      case 'set_content': {
        if (!key) throw new WriteRefused('No element.');
        if (!isJson || typeof body.content !== 'object' || body.content === null) throw new WriteRefused('set_content needs a JSON body with a content object.');
        await updateContent(versionId, key, body.content, ctx);
        return reply({ kind: 'ok', message: 'Saved.' }, key);
      }
      case 'remove': {
        if (!key) throw new WriteRefused('No element.');
        const n = await removeElement(versionId, key, ctx);
        return reply({ kind: 'ok', message: n === 1 ? 'Element removed.' : `Removed ${n} elements.` }, null);
      }
      default:
        return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
    }
  } catch (err) {
    const tab = str('tab', 12) || null;
    return reply({ kind: 'bad', message: err instanceof Error ? err.message : 'The change was not made.' }, key || null, tab);
  }
}
