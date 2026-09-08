#!/usr/bin/env node
/**
 * create-user.mjs - create one staff login with one or more roles, without any seed population.
 *
 * Used by `npm run reset:clean` to stand up an EMPTY instance: schema, config and framework only,
 * plus a single account. The account is created with the never-matching hash '!' (docs/14 §3) and
 * must be given a password with `npm run password -- <username>`; no secret passes through here.
 *
 * Usage:
 *   node --env-file=.env scripts/create-user.mjs <username> <role_code>[,<role_code>...]
 *   e.g. demo.training_manager training_manager
 */

import { connect } from './lib/kit-seed.mjs';

const username = process.argv[2];
const roles = (process.argv[3] ?? '').split(',').map((r) => r.trim()).filter(Boolean);
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
  for (const role of roles) {
    await client.query(
      `INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [user.id, role],
    );
  }
  await client.query('COMMIT');
  console.log(`user ${user.username} ready with role(s) ${roles.join(', ')} - now: npm run password -- ${user.username}`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
