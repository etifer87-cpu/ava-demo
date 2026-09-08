#!/usr/bin/env node
/**
 * create-user.mjs - create one staff login with one or more roles, without any seed population.
 *
 * Used by `npm run reset:clean` to stand up an EMPTY instance: schema, config and framework only,
 * plus a single account. The account is created with the never-matching hash '!' (docs/14 §3) and
 * must be given a password with `npm run password -- <username>`; no secret passes through here.
 *
 * Usage:
 *   node --env-file=.env scripts/create-user.mjs <username> <role_code>[,<role_code>...] [--fleet A320] [--org BOG]
 *   e.g. admin_av operator_admin
 *        tri.a320 instructor --fleet A320          (fleet-bound grant, migration 0142)
 *        fm.b787 fleet_manager --fleet B787
 * --fleet / --org bind EVERY role in the call; run the script twice for two different bindings.
 */

import { connect } from './lib/kit-seed.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const username = positional[0];
const roles = (positional[1] ?? '').split(',').map((r) => r.trim()).filter(Boolean);
const fleetCode = opt('--fleet');
const orgCode = opt('--org');
if (!username || roles.length === 0) {
  console.error('usage: create-user.mjs <username> <role_code>[,<role_code>...]');
  process.exit(2);
}

const client = await connect();
try {
  await client.query('BEGIN');
  const known = await client.query(`SELECT code FROM roles WHERE code = ANY($1::text[])`, [roles]);
  const missing = roles.filter((r) => !known.rows.some((k) => k.code === r));
  if (missing.length) throw new Error(`unknown role(s): ${missing.join(', ')}`);

  const { rows } = await client.query(
    `INSERT INTO users (person_id, username, password_hash, must_change_password, is_active)
     VALUES (NULL, $1, '!', false, true)
     ON CONFLICT (username) WHERE deleted_at IS NULL DO UPDATE SET is_active = true
     RETURNING id, username`,
    [username],
  );
  const user = rows[0];
  let fleetId = null;
  if (fleetCode) {
    const f = await client.query(`SELECT id FROM asset_classes WHERE code = $1 AND deleted_at IS NULL`, [fleetCode]);
    if (f.rows.length === 0) throw new Error(`unknown fleet (asset class) ${fleetCode}`);
    fleetId = f.rows[0].id;
  }
  let orgId = null;
  if (orgCode) {
    const o = await client.query(`SELECT id FROM org_units WHERE code = $1 AND deleted_at IS NULL`, [orgCode]);
    if (o.rows.length === 0) throw new Error(`unknown org unit ${orgCode}`);
    orgId = o.rows[0].id;
  }
  for (const role of roles) {
    await client.query(
      `INSERT INTO user_roles (user_id, role_code, org_unit_id, asset_class_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [user.id, role, orgId, fleetId],
    );
  }
  await client.query('COMMIT');
  const binding = [fleetCode ? `fleet ${fleetCode}` : null, orgCode ? `org ${orgCode}` : null].filter(Boolean).join(', ') || 'unbound';
  console.log(`user ${user.username} ready with role(s) ${roles.join(', ')} (${binding}) - now: npm run password -- ${user.username}`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
