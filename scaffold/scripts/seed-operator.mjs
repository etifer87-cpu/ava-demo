#!/usr/bin/env node
/**
 * seed-operator.mjs - the OPERATOR CONTEXT: org units (operator, AOC, bases, departments) and
 * asset classes (fleets and training devices) from config/policy.yaml.
 *
 * The kit writes these only inside the synthetic generator, which treats them as part of the demo
 * population. They are not: a fleet-bound grant (migration 0142) or a template scoped to a fleet
 * needs the asset class to exist on an instance that holds no people at all. Idempotent; runs
 * after config:load and before any user is created. Reads policy.yaml `synthetic.org_units` and
 * `synthetic.asset_classes` - the lists live there because the kit put them there; the section
 * name is a kit inheritance, not a statement that these rows are synthetic.
 */

import { connect, loadPolicy } from './lib/kit-seed.mjs';

const policyFile = await loadPolicy();
const policy = policyFile.data;
const units = policy.synthetic?.org_units ?? [];
const assets = policy.synthetic?.asset_classes ?? [];
if (units.length === 0 || assets.length === 0) {
  console.error('policy.yaml carries no org_units / asset_classes to seed.');
  process.exit(1);
}

const client = await connect();
try {
  await client.query('BEGIN');
  const orgIdByCode = new Map();
  units.forEach((u, i) => { u.position = i + 1; });
  // Parents first: the list is authored parent-before-child; resolve in order and fail loudly.
  for (const unit of units) {
    const parentId = unit.parent ? orgIdByCode.get(unit.parent) : null;
    if (unit.parent && !parentId) throw new Error(`org unit ${unit.code}: parent ${unit.parent} must be listed before it`);
    const { rows } = await client.query(
      `INSERT INTO org_units (code, name, kind, parent_id, position)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) WHERE deleted_at IS NULL
         DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, parent_id = EXCLUDED.parent_id, position = EXCLUDED.position
       RETURNING id`,
      [unit.code, unit.name, unit.kind, parentId, unit.position],
    );
    orgIdByCode.set(unit.code, rows[0].id);
  }
  const rootCode = units.find((u) => !u.parent)?.code;
  let n = 0;
  for (const [i, asset] of assets.entries()) {
    await client.query(
      `INSERT INTO asset_classes (code, name, category, org_unit_id, position)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) WHERE deleted_at IS NULL
         DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, position = EXCLUDED.position`,
      [asset.code, asset.name, asset.category, orgIdByCode.get(rootCode) ?? null, i + 1],
    );
    n += 1;
  }
  await client.query('COMMIT');
  console.log(`operator context seeded: ${units.length} org units (${units.map((u) => u.code).join(', ')}), ${n} asset classes (${assets.map((a) => a.code).join(', ')})`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
