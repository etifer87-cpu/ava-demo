import { NextResponse, type NextRequest } from 'next/server';
import { seeOther } from '@/lib/http';
import { transaction } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { audit, actorFromSession, requestContext, AUDIT_ACTIONS } from '@/lib/audit';
import { flashCookie, temporaryPassword } from '@/lib/admin';

/**
 * POST /api/admin/users - create an account, optionally with its roster row and role grants.
 *
 * One transaction: people row (linked by employee id if one is live, else created), users row
 * with a generated temporary password hashed BY POSTGRES (crypt + gen_salt('bf'), the same path
 * the login route verifies), then one user_roles row per ticked role with the chosen binding
 * (migration 0142). The password is handed to the next screen through the one-time flash cookie
 * and appears nowhere else - not in the audit row, not in a URL, not in a log line.
 *
 * Gate: platform.users.create; platform.roles.assign as well when roles are ticked.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/i;

function redirectWith(request: NextRequest, to: string, flash: Parameters<typeof flashCookie>[0]) {
  const res = seeOther(to);
  res.cookies.set(flashCookie(flash));
  return res;
}

export async function POST(request: NextRequest) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.users.create');

  const form = await request.formData();
  const str = (k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
  const username = str('username', 64).toLowerCase();
  const email = str('email') || null;
  const externalId = str('external_id', 40);
  const fullName = str('full_name');
  const position = str('position', 20) || null;
  const instructorRole = str('instructor_role', 20) || null;
  const assetClassId = str('asset_class_id', 40) || null;
  const orgUnitId = str('org_unit_id', 40) || null;
  const joinedOn = str('joined_on', 10) || null;
  const roles = form.getAll('roles').map((r) => String(r)).filter((r) => /^[a-z_]{3,40}$/.test(r));
  const bind = str('bind', 12) || 'none';

  if (!USERNAME.test(username)) {
    return redirectWith(request, '/admin/users/new', { kind: 'bad', message: 'Username must be 3-64 characters: letters, digits, dot, underscore or hyphen.' });
  }
  if (externalId && !fullName) {
    return redirectWith(request, '/admin/users/new', { kind: 'bad', message: 'A roster row needs a full name.' });
  }
  if (roles.length > 0) requireCapability(access, 'platform.roles.assign');

  const password = temporaryPassword();
  const actor = actorFromSession(session);
  const ctx = requestContext(request.headers);

  try {
    const created = await transaction(async (client) => {
      let personId: string | null = null;
      let personCreated = false;
      if (externalId) {
        const existing = await client.query<{ id: string; has_user: boolean }>(
          `SELECT p.id, EXISTS (SELECT 1 FROM users u WHERE u.person_id = p.id AND u.deleted_at IS NULL) AS has_user
             FROM people p WHERE p.external_id = $1 AND p.deleted_at IS NULL`,
          [externalId],
        );
        if (existing.rows[0]?.has_user) throw new Error(`Employee id ${externalId} already has an account.`);
        if (existing.rows[0]) {
          personId = existing.rows[0].id;
        } else {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO people (external_id, full_name, position, org_unit_id, asset_class_id, instructor_role, is_active, joined_on)
             VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, true, $7::date) RETURNING id`,
            [externalId, fullName, position, orgUnitId, assetClassId, instructorRole, joinedOn],
          );
          const created = ins.rows[0];
          if (!created) throw new Error('Could not create the roster row.');
          personId = created.id;
          personCreated = true;
        }
      }

      const dup = await client.query(`SELECT 1 FROM users WHERE username = $1 AND deleted_at IS NULL`, [username]);
      if (dup.rows.length) throw new Error(`Username ${username} is already taken.`);

      const user = await client.query<{ id: string }>(
        `INSERT INTO users (person_id, username, email, password_hash, must_change_password, is_active)
         VALUES ($1::uuid, $2, $3, crypt($4, gen_salt('bf', 12)), true, true) RETURNING id`,
        [personId, username, email, password],
      );
      const userRow = user.rows[0];
      if (!userRow) throw new Error('Could not create the account.');
      const userId = userRow.id;

      const grantFleet = bind === 'fleet' || bind === 'fleet_base' ? assetClassId : null;
      const grantOrg = bind === 'base' || bind === 'fleet_base' ? orgUnitId : null;
      for (const role of roles) {
        await client.query(
          `INSERT INTO user_roles (user_id, role_code, org_unit_id, asset_class_id, granted_by) VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid) ON CONFLICT DO NOTHING`,
          [userId, role, grantOrg, grantFleet, session.userId],
        );
      }

      await audit(
        { action: AUDIT_ACTIONS.userCreate, entityTable: 'users', entityId: userId, capabilityCode: 'platform.users.create',
          details: { username, external_id: externalId || null, person_created: personCreated, roles, bind } },
        actor, ctx, client,
      );
      if (roles.length) {
        await audit(
          { action: AUDIT_ACTIONS.userRolesChange, entityTable: 'users', entityId: userId, capabilityCode: 'platform.roles.assign',
            details: { added: roles, asset_class_id: grantFleet, org_unit_id: grantOrg } },
          actor, ctx, client,
        );
      }
      return userId;
    });

    return redirectWith(request, `/admin/users/${created}`, {
      kind: 'ok',
      message: `Account ${username} created. Give the person this temporary password; they must change it at first sign-in.`,
      secret: password,
      secretLabel: 'Temporary password',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not create the account.';
    return redirectWith(request, '/admin/users/new', { kind: 'bad', message });
  }
}
