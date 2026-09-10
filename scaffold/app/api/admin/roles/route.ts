import { NextResponse, type NextRequest } from 'next/server';
import { transaction } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { audit, actorFromSession, requestContext } from '@/lib/audit';
import { flashCookie } from '@/lib/admin';

/**
 * POST /api/admin/roles - the permission model's write path. `_action`:
 *
 *   create_role   code, name, module, description, copy_from      new roles row (+ copied grants)
 *   update_role   code, name, description                         label only; code never changes
 *   set_grants    code, scope:<capability>=<scope|''>             the whole matrix row for one role
 *
 * Rules enforced here, not on the screen: operator_admin is never edited; a capability with
 * is_overridable = false is never changed from here (hard gate - migrations only); the caller may
 * not remove platform.roles.assign from a role they hold themselves (the door stays open behind
 * you). One transaction, one audit row per changed cell. Gate: platform.roles.assign.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOCKED_ROLES = new Set(['operator_admin']);
const SCOPES = new Set(['own', 'assigned', 'team', 'org', 'all']);
const CODE = /^[a-z][a-z0-9_]{2,39}$/;
const MODULES = new Set(['platform', 'training', 'qms', 'dms', 'planning', 'integration']);

export async function POST(request: NextRequest) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.roles.assign');

  const form = await request.formData();
  const str = (k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
  const action = str('_action', 20);
  const code = str('code', 40);
  const actor = actorFromSession(session);
  const ctx = requestContext(request.headers);

  const back = (flash: Parameters<typeof flashCookie>[0], role = code) => {
    const res = NextResponse.redirect(new URL(role ? `/admin/roles?role=${role}` : '/admin/roles', request.nextUrl.origin), 303);
    res.cookies.set(flashCookie(flash));
    return res;
  };

  if (!CODE.test(code)) return back({ kind: 'bad', message: 'Role code must be 3-40 characters: lowercase letters, digits, underscore.' }, '');
  if (LOCKED_ROLES.has(code) && action !== 'create_role') return back({ kind: 'bad', message: `${code} is locked and cannot be edited.` });

  try {
    switch (action) {
      case 'create_role': {
        const name = str('name', 80);
        const module = str('module', 20);
        const description = str('description', 300);
        const copyFrom = str('copy_from', 40);
        if (name.length < 2) throw new Error('A label is required.');
        if (!MODULES.has(module)) throw new Error('Choose a module.');
        if (copyFrom && (!CODE.test(copyFrom) || LOCKED_ROLES.has(copyFrom))) throw new Error('Cannot copy from that role.');
        await transaction(async (client) => {
          const dup = await client.query(`SELECT 1 FROM roles WHERE code = $1`, [code]);
          if (dup.rows.length) throw new Error(`Role ${code} already exists.`);
          const pos = await client.query<{ p: number }>(`SELECT COALESCE(max(position), 0) + 10 AS p FROM roles WHERE position < 900`);
          await client.query(`INSERT INTO roles (code, name, module, description, position) VALUES ($1, $2, $3, $4, $5)`, [code, name, module, description, pos.rows[0].p]);
          let copied = 0;
          if (copyFrom) {
            const r = await client.query(
              `INSERT INTO role_capabilities (role_code, capability_code, scope)
               SELECT $1, rc.capability_code, rc.scope FROM role_capabilities rc JOIN capabilities c ON c.code = rc.capability_code
                WHERE rc.role_code = $2 AND c.is_overridable
               ON CONFLICT DO NOTHING`, [code, copyFrom]);
            copied = r.rowCount ?? 0;
          }
          await audit({ action: 'role.create', entityTable: 'roles', entityId: code, capabilityCode: 'platform.roles.assign', details: { name, module, copy_from: copyFrom || null, grants_copied: copied } }, actor, ctx, client);
        });
        return back({ kind: 'ok', message: `Role ${code} created.` });
      }

      case 'update_role': {
        const name = str('name', 80);
        const description = str('description', 300);
        if (name.length < 2) throw new Error('A label is required.');
        await transaction(async (client) => {
          const r = await client.query(`UPDATE roles SET name = $2, description = $3 WHERE code = $1 RETURNING code`, [code, name, description]);
          if (!r.rows.length) throw new Error('No such role.');
          await audit({ action: 'role.update', entityTable: 'roles', entityId: code, capabilityCode: 'platform.roles.assign', details: { name, description } }, actor, ctx, client);
        });
        return back({ kind: 'ok', message: 'Label saved.' });
      }

      case 'set_grants': {
        const wanted = new Map<string, string>();
        for (const [k, v] of form.entries()) {
          if (!k.startsWith('scope:')) continue;
          const cap = k.slice(6);
          const scope = String(v).trim();
          if (!/^[a-z][a-z0-9_.]{2,80}$/.test(cap)) continue;
          if (scope && !SCOPES.has(scope)) continue;
          wanted.set(cap, scope);
        }
        const changes = await transaction(async (client) => {
          const exists = await client.query(`SELECT 1 FROM roles WHERE code = $1`, [code]);
          if (!exists.rows.length) throw new Error('No such role.');
          const caps = await client.query<{ code: string; is_overridable: boolean; is_scoped: boolean }>(`SELECT code, is_overridable, is_scoped FROM capabilities`);
          const capInfo = new Map(caps.rows.map((c) => [c.code, c]));
          const cur = await client.query<{ capability_code: string; scope: string }>(`SELECT capability_code, scope FROM role_capabilities WHERE role_code = $1`, [code]);
          const held = new Map<string, string[]>();
          for (const g of cur.rows) held.set(g.capability_code, [...(held.get(g.capability_code) ?? []), g.scope]);
          const myRoles = new Set(session.roles);

          const changed: { capability: string; from: string[]; to: string }[] = [];
          for (const [cap, scope] of wanted) {
            const info = capInfo.get(cap);
            if (!info || !info.is_overridable) continue;                 // hard gates: migration only
            const effective = scope && !info.is_scoped ? 'all' : scope;
            const before = held.get(cap) ?? [];
            if (before.length === 1 && before[0] === effective) continue;
            if (before.length === 0 && !effective) continue;
            if (cap === 'platform.roles.assign' && !effective && myRoles.has(code)) {
              throw new Error('You cannot remove platform.roles.assign from a role you hold: the door would close behind you.');
            }
            await client.query(`DELETE FROM role_capabilities WHERE role_code = $1 AND capability_code = $2`, [code, cap]);
            if (effective) {
              await client.query(`INSERT INTO role_capabilities (role_code, capability_code, scope) VALUES ($1, $2, $3)`, [code, cap, effective]);
            }
            changed.push({ capability: cap, from: before, to: effective });
          }
          for (const c of changed) {
            await audit({ action: 'role.grant_change', entityTable: 'roles', entityId: code, capabilityCode: 'platform.roles.assign',
              details: { capability: c.capability, from: c.from.join('+') || 'none', to: c.to || 'none' } }, actor, ctx, client);
          }
          return changed.length;
        });
        return back({ kind: changes ? 'ok' : 'warn', message: changes ? `${changes} permission${changes === 1 ? '' : 's'} changed for ${code}. Holders see it on their next request.` : 'Nothing changed.' });
      }

      default:
        return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
    }
  } catch (err) {
    return back({ kind: 'bad', message: err instanceof Error ? err.message : 'The change failed.' });
  }
}
