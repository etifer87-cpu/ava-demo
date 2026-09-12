import { NextResponse, type NextRequest } from 'next/server';
import { query, queryOne, transaction } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { audit, actorFromSession, requestContext, AUDIT_ACTIONS } from '@/lib/audit';
import { flashCookie, temporaryPassword } from '@/lib/admin';
import { policy } from '@/lib/config';

/**
 * POST /api/admin/users/[id] - one account, one `_action`:
 *
 *   update_person   roster fields                       platform.users.manage
 *   reset_password  new temporary password, shown once  platform.users.manage
 *   unlock          clear a lockout                      platform.users.manage
 *   deactivate      is_active = false (never deleted)    platform.users.manage   not on yourself
 *   reactivate      is_active = true                     platform.users.manage
 *   grant           add a role grant with binding        platform.roles.assign
 *   revoke          remove one grant                     platform.roles.assign   not your own operator_admin
 *
 * Every action writes one audit row naming the capability it used. A form POST redirects back to
 * the account page with a flash; a JSON caller gets JSON.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Flash = Parameters<typeof flashCookie>[0];

function back(request: NextRequest, id: string, flash: Flash, status = 303) {
  if ((request.headers.get('accept') ?? '').includes('application/json')) {
    return NextResponse.json({ ok: flash.kind !== 'bad', message: flash.message }, { status: flash.kind === 'bad' ? 400 : 200 });
  }
  const res = NextResponse.redirect(new URL(`/admin/users/${id}`, request.nextUrl.origin), status);
  res.cookies.set(flashCookie(flash));
  return res;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.users.view');

  const form = await request.formData();
  const str = (k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
  const action = str('_action', 20);
  const actor = actorFromSession(session);
  const ctx = requestContext(request.headers);
  const self = id === session.userId;

  const target = await queryOne<{ id: string; username: string; person_id: string | null; is_active: boolean }>(
    `SELECT id, username, person_id, is_active FROM users WHERE id = $1::uuid AND deleted_at IS NULL`, [id],
  );
  if (!target) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

  try {
    switch (action) {
      case 'update_person': {
        requireCapability(access, 'platform.users.manage');
        if (!target.person_id) throw new Error('This account has no roster row.');
        const order = policy().instructor_roles;
        const quals = form.getAll('instructor_roles').map((v) => String(v)).filter((v) => order.includes(v)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
        await query(
          `UPDATE people SET full_name = COALESCE(NULLIF($2, ''), full_name), position = NULLIF($3, ''),
                  instructor_role = $4, instructor_roles = $5::text[], asset_class_id = NULLIF($6, '')::uuid, org_unit_id = NULLIF($7, '')::uuid
            WHERE id = $1::uuid`,
          [target.person_id, str('full_name'), str('position', 20), quals[0] ?? null, quals, str('asset_class_id', 40), str('org_unit_id', 40)],
        );
        await audit({ action: AUDIT_ACTIONS.userUpdate, entityTable: 'users', entityId: id, capabilityCode: 'platform.users.manage', details: { roster: 'updated' } }, actor, ctx);
        return back(request, id, { kind: 'ok', message: 'Roster row saved.' });
      }

      case 'reset_password': {
        requireCapability(access, 'platform.users.manage');
        const password = temporaryPassword();
        await query(
          `UPDATE users SET password_hash = crypt($2, gen_salt('bf', 12)), must_change_password = true, locked_until = NULL, failed_login_count = 0 WHERE id = $1::uuid`,
          [id, password],
        );
        await audit({ action: AUDIT_ACTIONS.userPasswordReset, entityTable: 'users', entityId: id, capabilityCode: 'platform.users.manage' }, actor, ctx);
        return back(request, id, { kind: 'ok', message: `Password reset for ${target.username}. They must change it at next sign-in.`, secret: password, secretLabel: 'Temporary password' });
      }

      case 'unlock': {
        requireCapability(access, 'platform.users.manage');
        await query(`UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE id = $1::uuid`, [id]);
        await audit({ action: AUDIT_ACTIONS.userUpdate, entityTable: 'users', entityId: id, capabilityCode: 'platform.users.manage', details: { unlocked: true } }, actor, ctx);
        return back(request, id, { kind: 'ok', message: 'Account unlocked.' });
      }

      case 'deactivate': {
        requireCapability(access, 'platform.users.manage');
        if (self) throw new Error('You cannot deactivate your own account.');
        await query(`UPDATE users SET is_active = false WHERE id = $1::uuid`, [id]);
        await audit({ action: AUDIT_ACTIONS.userDeactivate, entityTable: 'users', entityId: id, capabilityCode: 'platform.users.manage' }, actor, ctx);
        return back(request, id, { kind: 'warn', message: `${target.username} deactivated. The account keeps its history and can be reactivated.` });
      }

      case 'reactivate': {
        requireCapability(access, 'platform.users.manage');
        await query(`UPDATE users SET is_active = true WHERE id = $1::uuid`, [id]);
        await audit({ action: AUDIT_ACTIONS.userUpdate, entityTable: 'users', entityId: id, capabilityCode: 'platform.users.manage', details: { reactivated: true } }, actor, ctx);
        return back(request, id, { kind: 'ok', message: `${target.username} reactivated.` });
      }

      case 'grant': {
        requireCapability(access, 'platform.roles.assign');
        const role = str('role_code', 40);
        const fleet = str('asset_class_id', 40) || null;
        const org = str('org_unit_id', 40) || null;
        const expires = str('expires_on', 10) || null;
        if (!/^[a-z_]{3,40}$/.test(role)) throw new Error('Choose a role.');
        await transaction(async (client) => {
          const known = await client.query(`SELECT 1 FROM roles WHERE code = $1`, [role]);
          if (!known.rows.length) throw new Error(`Unknown role ${role}.`);
          const r = await client.query(
            `INSERT INTO user_roles (user_id, role_code, org_unit_id, asset_class_id, expires_at, granted_by)
             VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::date, $6::uuid) ON CONFLICT DO NOTHING RETURNING role_code`,
            [id, role, org, fleet, expires, session.userId],
          );
          if (!r.rows.length) throw new Error('That grant already exists.');
          await audit({ action: AUDIT_ACTIONS.userRolesChange, entityTable: 'users', entityId: id, capabilityCode: 'platform.roles.assign',
            details: { added: role, asset_class_id: fleet, org_unit_id: org, expires_on: expires } }, actor, ctx, client);
        });
        return back(request, id, { kind: 'ok', message: `Grant added: ${role}.` });
      }

      case 'revoke': {
        requireCapability(access, 'platform.roles.assign');
        const role = str('role_code', 40);
        const fleetCode = str('asset_class_code', 20) || null;
        const orgCode = str('org_unit_code', 20) || null;
        if (self && role === 'operator_admin') throw new Error('You cannot remove your own administrator role.');
        await transaction(async (client) => {
          const r = await client.query(
            `DELETE FROM user_roles ur
              WHERE ur.user_id = $1::uuid AND ur.role_code = $2
                AND ((ur.asset_class_id IS NULL AND $3::text IS NULL) OR ur.asset_class_id = (SELECT id FROM asset_classes WHERE code = $3 AND deleted_at IS NULL))
                AND ((ur.org_unit_id IS NULL AND $4::text IS NULL) OR ur.org_unit_id = (SELECT id FROM org_units WHERE code = $4 AND deleted_at IS NULL))
              RETURNING ur.role_code`,
            [id, role, fleetCode, orgCode],
          );
          if (!r.rows.length) throw new Error('No such grant.');
          await audit({ action: AUDIT_ACTIONS.userRolesChange, entityTable: 'users', entityId: id, capabilityCode: 'platform.roles.assign',
            details: { removed: role, asset_class_code: fleetCode, org_unit_code: orgCode } }, actor, ctx, client);
        });
        return back(request, id, { kind: 'warn', message: `Grant removed: ${role}.` });
      }

      default:
        return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    return back(request, id, { kind: 'bad', message: err instanceof Error ? err.message : 'The action failed.' });
  }
}
