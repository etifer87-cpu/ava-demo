import { NextResponse, type NextRequest } from 'next/server';
import { query, transaction } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { audit, actorFromSession, requestContext } from '@/lib/audit';
import { flashCookie } from '@/lib/admin';
import { suggestCode } from '@/lib/templates';
import { parseMinutes, formatMinutes } from '@/lib/program/shape';

/**
 * POST /api/templates - the Programs list's write path. `_action`:
 *
 *   create      name, code, kind, fleet, period, device, program_*, notes
 *   archive     ids[]                      is_active = false; the program leaves the default list
 *   unarchive   ids[]
 *   delete      ids[], password            soft delete (deleted_at) of the template and its versions.
 *                                          Re-authenticated: the caller's password is checked by
 *                                          Postgres the same way the login is, and the attempt is
 *                                          written to the app log whether it succeeds or not. A
 *                                          program any session has used is never deleted - archive it.
 *
 * One transaction: the session_templates row, its version 1 as a draft carrying the version-level
 * set-up, current_version_id pointed at it, one audit row. The kind is checked against the
 * template_kinds catalogue and the fleet against asset_classes, both by the database, so an
 * unknown value is a sentence and not a constraint name. Gate: training.templates.configure.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CODE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

export async function POST(request: NextRequest) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.configure');

  const form = await request.formData();
  const str = (k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
  const action = str('_action', 20);
  const actor = actorFromSession(session);
  const ctx = requestContext(request.headers);

  const back = (flash: Parameters<typeof flashCookie>[0], to = '/templates/new') => {
    const res = NextResponse.redirect(new URL(to, request.nextUrl.origin), 303);
    res.cookies.set(flashCookie(flash, '/templates'));
    return res;
  };

  if (action === 'archive' || action === 'unarchive' || action === 'delete') return batch(action, form, request, session, actor, ctx);
  if (action !== 'create') return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });

  const name = str('name', 120);
  const code = str('code', 63) || suggestCode(name);
  const kind = str('kind', 40);
  const fleet = str('fleet', 40) || null;
  const periodRaw = str('period', 10);
  const period = periodRaw ? parseMinutes(periodRaw) : null;
  const device = str('device', 40) || null;
  const notes = str('notes', 300) || null;
  const intOrNull = (k: string, max: number) => { const v = str(k, 5); if (!v) return null; const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= max ? n : NaN; };
  const day = intOrNull('program_day', 30);
  const cycle = intOrNull('cycle_months', 60);

  if (name.length < 3) return back({ kind: 'bad', message: 'A name of at least three characters is required.' });
  if (!CODE.test(code)) return back({ kind: 'bad', message: 'The code must be lowercase letters, digits, dot, dash or underscore, up to 63 characters.' });
  if (!kind) return back({ kind: 'bad', message: 'Choose a kind.' });
  if (periodRaw && period === null) return back({ kind: 'bad', message: 'The period must read like 4:00.' });
  if (Number.isNaN(day) || Number.isNaN(cycle)) return back({ kind: 'bad', message: 'Day and cycle must be whole numbers.' });
  if (fleet && !/^[0-9a-f-]{36}$/i.test(fleet)) return back({ kind: 'bad', message: 'Choose a fleet from the list.' });

  const setup = {
    program: { code: str('program_code', 40) || null, module: str('program_module', 40) || null, phase: str('program_phase', 40) || null, day, cycle_months: cycle },
    period: period === null ? null : formatMinutes(period),
    device,
    aims: { aims: null, competency_focus: null, grading_criteria: null, visibility: 'instructor_only' },
  };

  try {
    const templateId = await transaction(async (client) => {
      const k = await client.query(`SELECT 1 FROM template_kinds WHERE code = $1 AND is_active`, [kind]);
      if (!k.rows.length) throw new Error(`"${kind}" is not an active template kind.`);
      if (fleet) {
        const f = await client.query(`SELECT 1 FROM asset_classes WHERE id = $1::uuid AND deleted_at IS NULL AND is_active`, [fleet]);
        if (!f.rows.length) throw new Error('That fleet does not exist.');
      }
      if (device) {
        const d = await client.query(`SELECT 1 FROM asset_classes WHERE code = $1 AND deleted_at IS NULL AND is_active`, [device]);
        if (!d.rows.length) throw new Error('That device does not exist.');
      }
      const dup = await client.query(`SELECT 1 FROM session_templates WHERE code = $1 AND deleted_at IS NULL`, [code]);
      if (dup.rows.length) throw new Error(`A program with code ${code} already exists.`);

      const t = await client.query<{ id: string }>(
        `INSERT INTO session_templates (code, name, template_kind, asset_class_id, created_by) VALUES ($1, $2, $3, $4::uuid, $5::uuid) RETURNING id`,
        [code, name, kind, fleet, session.userId],
      );
      const templateId = t.rows[0]?.id;
      if (!templateId) throw new Error('The program was not created.');
      const v = await client.query<{ id: string }>(
        `INSERT INTO session_template_versions (template_id, version, status, setup, notes) VALUES ($1::uuid, 1, 'draft', $2::jsonb, $3) RETURNING id`,
        [templateId, JSON.stringify(setup), notes],
      );
      const versionId = v.rows[0]?.id;
      if (!versionId) throw new Error('The first version was not created.');
      await client.query(`UPDATE session_templates SET current_version_id = $2::uuid WHERE id = $1::uuid`, [templateId, versionId]);
      await audit({ action: 'template.create', entityTable: 'session_templates', entityId: templateId, capabilityCode: 'training.templates.configure',
        details: { code, name, kind, fleet, version_id: versionId, period: setup.period, program: setup.program } }, actor, ctx, client);
      return templateId;
    });
    return back({ kind: 'ok', message: `${name} created as version 1, draft.` }, `/templates/${templateId}`);
  } catch (err) {
    return back({ kind: 'bad', message: err instanceof Error ? err.message : 'The program was not created.' });
  }
}

async function batch(action: 'archive' | 'unarchive' | 'delete', form: FormData, request: NextRequest, session: Awaited<ReturnType<typeof requireSession>>, actor: ReturnType<typeof actorFromSession>, ctx: ReturnType<typeof requestContext>) {
  const ids = form.getAll('ids').map((v) => String(v)).filter((v) => /^[0-9a-f-]{36}$/i.test(v)).slice(0, 200);
  const status = String(form.get('status') ?? '').slice(0, 20);
  const reason = String(form.get('reason') ?? '').trim().slice(0, 500);
  const back = (flash: Parameters<typeof flashCookie>[0]) => {
    const url = new URL(status === 'inactive' ? '/templates/archive' : '/templates', request.nextUrl.origin);
    if (status && status !== 'inactive') url.searchParams.set('status', status);
    const res = NextResponse.redirect(url, 303);
    res.cookies.set(flashCookie(flash, '/templates'));
    return res;
  };
  if (ids.length === 0) return back({ kind: 'warn', message: 'Nothing selected.' });

  if (action === 'delete') {
    const password = String(form.get('password') ?? '');
    if (reason.length < 3) return back({ kind: 'bad', message: 'A reason is required to delete.' });
    const check = await query<{ ok: boolean }>(`SELECT (password_hash = crypt($2, password_hash)) AS ok FROM users WHERE id = $1::uuid AND deleted_at IS NULL AND is_active`, [session.userId, password]);
    if (!password || !check[0]?.ok) {
      await audit({ action: 'template.delete.refused', entityTable: 'session_templates', capabilityCode: 'training.templates.configure', reason, details: { ids, refused: 'password did not verify' } }, actor, ctx);
      return back({ kind: 'bad', message: 'Password did not verify. Nothing was deleted; the attempt is in the app log.' });
    }
  }

  try {
    const result = await transaction(async (client) => {
      const rows = (await client.query<{ id: string; code: string; name: string; used: number }>(
        `SELECT t.id, t.code, t.name,
                (SELECT count(*)::int FROM sessions s JOIN session_template_versions v ON v.id = s.template_version_id WHERE v.template_id = t.id) AS used
           FROM session_templates t WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL`, [ids])).rows;
      const done: string[] = []; const kept: string[] = [];
      for (const t of rows) {
        if (action === 'delete') {
          if (t.used > 0) { kept.push(`${t.name} (${t.used} session${t.used === 1 ? '' : 's'})`); continue; }
          await client.query(`UPDATE session_template_versions SET deleted_at = now() WHERE template_id = $1::uuid AND deleted_at IS NULL`, [t.id]);
          await client.query(`UPDATE session_templates SET deleted_at = now(), is_active = false WHERE id = $1::uuid`, [t.id]);
          await audit({ action: 'template.delete', entityTable: 'session_templates', entityId: t.id, capabilityCode: 'training.templates.configure', reason, details: { code: t.code, name: t.name, reauthenticated: true } }, actor, ctx, client);
        } else {
          await client.query(`UPDATE session_templates SET is_active = $2 WHERE id = $1::uuid`, [t.id, action === 'unarchive']);
          await audit({ action: action === 'archive' ? 'template.archive' : 'template.unarchive', entityTable: 'session_templates', entityId: t.id, capabilityCode: 'training.templates.configure', details: { code: t.code, name: t.name } }, actor, ctx, client);
        }
        done.push(t.name);
      }
      return { done, kept };
    });
    const verb = action === 'delete' ? 'deleted' : action === 'archive' ? 'archived' : 'restored';
    const msg = `${result.done.length} program${result.done.length === 1 ? '' : 's'} ${verb}.` + (result.kept.length ? ` Not deleted because sessions used them - archive instead: ${result.kept.join('; ')}.` : '');
    return back({ kind: result.kept.length && !result.done.length ? 'warn' : 'ok', message: msg });
  } catch (err) {
    return back({ kind: 'bad', message: err instanceof Error ? err.message : 'The change was not made.' });
  }
}
