#!/usr/bin/env node
/**
 * create-user.mjs - create one staff login with one or more roles, without any seed population.
 *
 * Used by `npm run reset:clean` to stand up an EMPTY instance: schema, config and framework only,
 * plus a single account. The account is created with the never-matching hash '!' (docs/14 §3) and
 * must be given a password with `npm run password -- <username>`; no secret passes through here.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/create-user.mjs <username> <role_code>[,<role_code>...]
 *        [--fleet A320] [--org BOG] [--person AV20110]
 *   e.g. admin_av operator_admin
 *        tri.a320 instructor --fleet A320          (fleet-bound grant, migration 0142)
 *        fm.b787 fleet_manager --fleet B787
 *        a.betancur instructor --fleet A320 --person "Andrea Betancur"
 * --fleet / --org bind EVERY role in the call; run the script twice for two different bindings.
 *
 * --person LINKS THE ACCOUNT TO A ROSTER ROW, and an instructor account is useless without it.
 * A login and a person are different things here on purpose: an administrator has no roster row,
 * and a pilot has a roster row long before anyone gives them a login. But an INSTRUCTOR is named
 * on sessions as a person, so an instructor account with users.person_id NULL cannot be the
 * instructor of record - /sessions/new refuses it with "This account is not linked to a roster
 * row". Until this option existed the script always wrote NULL and there was no way to fix it
 * except by hand in the admin screens, which is not something a rehearsal should have to find out.
 *
 * The value is an external_id (the staff number, e.g. AV20110) or a full name. A name that matches
 * more than one active person is an ERROR rather than a guess: the wrong instructor on a signed
 * record is not a mistake anybody would notice until an audit.
 */

import { connect } from './lib/kit-seed.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const username = positional[0];
const roles = (positional[1] ?? '').split(',').map((r) => r.trim()).filter(Boolean);
const fleetCode = opt('--fleet');
const orgCode = opt('--org');
const person = opt('--person');
if (!username || roles.length === 0) {
  console.error('usage: create-user.mjs <username> <role_code>[,<role_code>...] [--fleet A320] [--org BOG] [--person AV20110]');
  process.exit(2);
}

const client = await connect();
try {
  await client.query('BEGIN');
  const known = await client.query(`SELECT code FROM roles WHERE code = ANY($1::text[])`, [roles]);
  const missing = roles.filter((r) => !known.rows.some((k) => k.code === r));
  if (missing.length) throw new Error(`unknown role(s): ${missing.join(', ')}`);

  // Resolve the roster row BEFORE writing anything: a bad --person must fail the whole call rather
  // than leave a half-made account behind for the next run to find.
  let personId = null;
  let personLabel = null;
  if (person) {
    const p = await client.query(
      `SELECT id::text AS id, external_id, full_name
         FROM people
        WHERE deleted_at IS NULL AND is_active
          AND (external_id = $1 OR lower(full_name) = lower($1))
        ORDER BY external_id`,
      [person],
    );
    if (p.rows.length === 0) throw new Error(`no active roster row matches --person ${person} (try the staff number, e.g. AV20110)`);
    if (p.rows.length > 1) {
      const which = p.rows.map((r) => `${r.external_id} ${r.full_name}`).join('; ');
      throw new Error(`--person ${person} matches ${p.rows.length} people - name the staff number instead: ${which}`);
    }
    personId = p.rows[0].id;
    personLabel = `${p.rows[0].external_id} ${p.rows[0].full_name}`;
  }

  const { rows } = await client.query(
    `INSERT INTO users (person_id, username, password_hash, must_change_password, is_active)
     VALUES ($2::uuid, $1, '!', false, true)
     ON CONFLICT (username) WHERE deleted_at IS NULL DO UPDATE SET
       is_active = true,
       -- Only ever SETS the link, never clears one: re-running without --person to add a role must
       -- not quietly unlink an account that sessions already name.
       person_id = COALESCE(EXCLUDED.person_id, users.person_id)
     RETURNING id, username, person_id`,
    [username, personId],
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
  const link = personLabel ? `, linked to ${personLabel}` : (user.person_id ? ', roster link unchanged' : ', NOT linked to a roster row');
  console.log(`user ${user.username} ready with role(s) ${roles.join(', ')} (${binding})${link} - now: npm run password -- ${user.username}`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
