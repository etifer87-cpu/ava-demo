#!/usr/bin/env node
/**
 * seed-roster.mjs - loads data/roster/pilots.json into `people`.
 *
 *   npm run seed:roster
 *
 * Idempotent: upsert by external_id (the seniority number, or CAND-<year>-<n> for a screening
 * candidate). Bases resolve to org_units by code, fleets to asset_classes by code; a code that
 * does not exist is a sentence, not a foreign-key error. Candidates and leavers are is_active =
 * false so every kit scope query keeps meaning "on the roster"; roster_status carries the reason.
 * `instructor_role` (the kit's single column) is the highest qualification held, in the order
 * policy.yaml lists instructor_roles; `instructor_roles` carries all of them.
 *
 * No training data: sessions and records come from their own generator, later.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { connect, KIT_ROOT, loadPolicy } from './lib/kit-seed.mjs';

const file = process.env.ROSTER_FILE ?? path.resolve(KIT_ROOT, 'data', 'roster', 'pilots.json');
const roster = JSON.parse(await readFile(file, 'utf8'));
const policy = (await loadPolicy()).data;
const ROLE_ORDER = policy.instructor_roles ?? [];
const highest = (roles) => [...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))[0] ?? null;

const client = await connect();
try {
  await client.query('BEGIN');
  const orgByCode = new Map((await client.query(`SELECT id, code FROM org_units WHERE deleted_at IS NULL`)).rows.map((r) => [r.code, r.id]));
  const fleetByCode = new Map((await client.query(`SELECT id, code FROM asset_classes WHERE deleted_at IS NULL`)).rows.map((r) => [r.code, r.id]));
  let n = 0;
  for (const p of roster.pilots) {
    if (p.base && !orgByCode.has(p.base)) throw new Error(`${p.external_id}: base ${p.base} is not an org unit; run seed:operator first`);
    if (p.fleet && !fleetByCode.has(p.fleet)) throw new Error(`${p.external_id}: fleet ${p.fleet} is not an asset class; run seed:operator first`);
    for (const r of p.instructor_roles) if (!ROLE_ORDER.includes(r)) throw new Error(`${p.external_id}: instructor role ${r} is not in policy.yaml instructor_roles`);
    await client.query(
      `INSERT INTO people (external_id, full_name, position, org_unit_id, asset_class_id, instructor_role, is_active, joined_on,
                           seniority_number, sex, licence_number, total_hours, hours_on_type, rank_since, fleet_since, instructor_roles, roster_status, left_on)
       VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8::date, $9, $10, $11, $12, $13, $14::date, $15::date, $16::text[], $17, $18::date)
       ON CONFLICT (external_id) WHERE deleted_at IS NULL DO UPDATE SET
         full_name = EXCLUDED.full_name, position = EXCLUDED.position, org_unit_id = EXCLUDED.org_unit_id, asset_class_id = EXCLUDED.asset_class_id,
         instructor_role = EXCLUDED.instructor_role, is_active = EXCLUDED.is_active, joined_on = EXCLUDED.joined_on,
         seniority_number = EXCLUDED.seniority_number, sex = EXCLUDED.sex, licence_number = EXCLUDED.licence_number, total_hours = EXCLUDED.total_hours,
         hours_on_type = EXCLUDED.hours_on_type, rank_since = EXCLUDED.rank_since, fleet_since = EXCLUDED.fleet_since, instructor_roles = EXCLUDED.instructor_roles,
         roster_status = EXCLUDED.roster_status, left_on = EXCLUDED.left_on`,
      [p.external_id, p.full_name, p.position, p.base ? orgByCode.get(p.base) : null, p.fleet ? fleetByCode.get(p.fleet) : null, highest(p.instructor_roles),
       p.roster_status === 'active', p.joined_on, p.seniority, p.sex, p.licence_number, p.total_hours, p.hours_on_type, p.rank_since, p.fleet_since,
       p.instructor_roles, p.roster_status, p.left_on ?? null],
    );
    n += 1;
  }
  await client.query('COMMIT');
  const active = roster.pilots.filter((p) => p.roster_status === 'active').length;
  console.log(`roster seeded: ${n} people (${active} active, ${n - active} candidates or left) from ${path.basename(file)}, seed ${roster.seed}`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
