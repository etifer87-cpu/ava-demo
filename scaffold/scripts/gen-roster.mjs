#!/usr/bin/env node
/**
 * gen-roster.mjs - builds the pilot roster into data/roster/pilots.json.
 *
 *   npm run gen:roster
 *
 * Pure: reads config/policy.yaml `roster` and writes one file; no database. Deterministic on the
 * seed, so the same policy gives the same 500 pilots every time. No training data here: names,
 * ranks, fleets, bases, seniority, experience, instructor qualifications and the screening
 * candidates. Every person is invented; the names are combined from the lists in policy.yaml.
 *
 * Seniority: 1 is the most senior. The list is the career ladder in order - B787 captains, A320
 * captains, B787 first officers, A320 first officers - because every pilot is hired as an A320 FO
 * and moves up by seniority. Hire dates follow `hires_per_year`, oldest first, so seniority and
 * date joined agree.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng, isoDate, parseDate, addDays, addMonths, parseYaml } from './lib/kit-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const policy = parseYaml(await readFile(path.join(ROOT, 'scaffold', 'config', 'policy.yaml'), 'utf8'));
const R = policy.roster;
if (!R) { console.error('policy.yaml has no roster section'); process.exit(1); }

const asOf = parseDate(R.as_of);
const rng = makeRng(R.seed, 'roster');
const totalHires = Object.values(R.hires_per_year).reduce((a, b) => a + b, 0);
const totalRanks = R.ranks.reduce((a, r) => a + r.count, 0);
if (totalHires !== R.total || totalRanks !== R.total) { console.error(`roster: total ${R.total}, hires ${totalHires}, ranks ${totalRanks} - they must agree`); process.exit(1); }

/* ------------------------------------------------------------------ names, unique */
const used = new Set();
function nameFor(sex, fixed = null) {
  if (fixed) { used.add(fixed); return fixed; }
  for (let i = 0; i < 200; i += 1) {
    const given = rng.pick(sex === 'F' ? R.given_names_female : R.given_names_male);
    const family = rng.pick(R.family_names);
    const second = rng.chance(0.55) ? ` ${rng.pick(R.family_names)}` : '';
    const name = `${given} ${family}${second}`;
    if (family === (second.trim() || null)) continue;
    if (!used.has(name)) { used.add(name); return name; }
  }
  throw new Error('ran out of unique names; widen the lists in policy.yaml');
}

/* ------------------------------------------------------------------ hire dates, oldest first */
const joinDates = [];
for (const [year, n] of Object.entries(R.hires_per_year).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const y = Number(year);
  const end = y === asOf.getUTCFullYear() ? asOf : parseDate(`${y}-12-31`);
  const start = parseDate(`${y}-01-01`);
  const span = Math.floor((end - start) / 86400000);
  const days = Array.from({ length: n }, () => rng.int(0, span)).sort((a, b) => a - b);
  for (const d of days) joinDates.push(addDays(start, d));
}

/* ------------------------------------------------------------------ pilots */
const yearsIn = (key) => { const [lo, hi] = R.years_in_rank[key]; return lo + rng.next() * (hi - lo); };
const hoursPerYear = () => rng.int(R.hours_per_year[0], R.hours_per_year[1]);
const pickBase = (fleet) => { const shares = R.bases[fleet]; let x = rng.next(); for (const [code, p] of Object.entries(shares)) { x -= p; if (x <= 0) return code; } return Object.keys(shares)[0]; };
const clampDate = (d) => (d > asOf ? asOf : d);
const yearsBetween = (a, b) => (b - a) / (365.25 * 86400000);

const pilots = [];
let seniority = 0;
for (const rank of R.ranks) {
  for (let i = 0; i < rank.count; i += 1) {
    seniority += 1;
    const joined = joinDates[seniority - 1];
    const sex = rng.chance(R.female_share) ? 'F' : 'M';
    // Career steps from the join date; the current rank is where the ladder stands today.
    const steps = [];
    let t = joined;
    const ladder = ['A320_FO', 'B787_FO', 'A320_CP', 'B787_CP'];
    const current = `${rank.fleet}_${rank.position}`;
    for (const step of ladder) {
      steps.push({ step, from: clampDate(t) });
      if (step === current) break;
      t = addMonths(t, Math.round(yearsIn(step) * 12));
    }
    // If the drawn years overshoot today, compress so the current rank started at least a month ago.
    let rankSince = steps[steps.length - 1].from;
    if (rankSince >= addMonths(asOf, -1)) rankSince = addMonths(asOf, -rng.int(1, 18));
    if (rankSince < joined) rankSince = joined;
    const fleetSince = (() => { const idx = steps.findIndex((s) => s.step === current); const prev = steps[idx - 1]; return prev && prev.step.startsWith(rank.fleet) ? prev.from : rankSince; })();
    const before = rng.int(R.hours_before_joining[0], R.hours_before_joining[1]);
    const total = before + Math.round(yearsBetween(joined, asOf) * hoursPerYear());
    const onType = Math.min(total, Math.round(yearsBetween(fleetSince, asOf) * hoursPerYear()));
    pilots.push({
      seniority, external_id: String(seniority), sex, full_name: null,
      fleet: rank.fleet, position: rank.position, base: pickBase(rank.fleet),
      joined_on: isoDate(joined), rank_since: isoDate(rankSince), fleet_since: isoDate(fleetSince),
      total_hours: total, hours_on_type: Math.max(onType, 50),
      licence_number: `${R.licence[rank.position]}${String(100000 + seniority * 37 + rng.int(0, 36)).slice(-6)}`,
      instructor_roles: [], roster_status: 'active',
    });
  }
}

/* ------------------------------------------------------------------ instructor bench */
const captains = pilots.filter((p) => p.position === 'CP');
const fos = pilots.filter((p) => p.position === 'FO');
// Named placements first: a named person takes a seat in the requested fleet/rank, in the senior half.
for (const n of R.instructors.named ?? []) {
  const pool = pilots.filter((p) => p.fleet === n.fleet && p.position === n.position && p.instructor_roles.length === 0 && !p.full_name);
  const target = pool[Math.floor(pool.length * 0.35)];
  target.full_name = nameFor(n.sex, n.name); target.sex = n.sex; target.instructor_roles = [...n.roles];
}
// Examiners and instructors from the senior two thirds of the captains, spread across fleets by size.
const draw = (pool, count, roles) => {
  const senior = pool.filter((p) => p.instructor_roles.length === 0).slice(0, Math.ceil(pool.length * 0.66));
  for (const p of rng.sample(senior, count)) p.instructor_roles = [...roles];
};
const capRoles = R.instructors.captains;
const b787Cap = captains.filter((p) => p.fleet === 'B787');
const a320Cap = captains.filter((p) => p.fleet === 'A320');
const share = (n) => { const b = Math.max(1, Math.round(n * b787Cap.length / captains.length)); return [n - b, b]; };
for (const [role, count] of Object.entries(capRoles)) {
  const [a, b] = share(count);
  // TRE holders are also TRI; SFE holders also SFI - the examiner qualification sits on top.
  const roles = role === 'TRE' ? ['TRE', 'TRI'] : role === 'SFE' ? ['SFE', 'SFI'] : [role];
  draw(a320Cap, a, roles); draw(b787Cap, b, roles);
}
for (const [role, count] of Object.entries(R.instructors.first_officers)) draw(fos.slice(0, Math.ceil(fos.length * 0.5)), count, [role]);

/* ------------------------------------------------------------------ names for everyone else */
for (const p of pilots) if (!p.full_name) p.full_name = nameFor(p.sex);

/* ------------------------------------------------------------------ candidates */
const candidates = [];
for (let i = 1; i <= R.candidates; i += 1) {
  const sex = rng.chance(0.2) ? 'F' : 'M';
  candidates.push({
    seniority: null, external_id: `CAND-${asOf.getUTCFullYear()}-${String(i).padStart(2, '0')}`, sex, full_name: nameFor(sex),
    fleet: null, position: null, base: null, joined_on: null, rank_since: null, fleet_since: null,
    total_hours: rng.int(250, 3500), hours_on_type: 0, licence_number: `${R.licence.FO}${String(200000 + i * 53).slice(-6)}`,
    instructor_roles: [], roster_status: 'candidate',
  });
}

const out = { note: 'Pilot roster generated by scripts/gen-roster.mjs from policy.yaml `roster`. Every person is invented. No training data.', seed: R.seed, as_of: R.as_of, pilots: [...pilots, ...candidates] };
await mkdir(path.join(ROOT, 'data', 'roster'), { recursive: true });
await writeFile(path.join(ROOT, 'data', 'roster', 'pilots.json'), JSON.stringify(out, null, 2) + '\n');
const bench = {};
for (const p of pilots) for (const r of p.instructor_roles) bench[r] = (bench[r] ?? 0) + 1;
console.log(`${pilots.length} pilots (${R.ranks.map((r) => `${r.count} ${r.fleet} ${r.position}`).join(', ')}), ${candidates.length} candidates; bench ${Object.entries(bench).map(([k, v]) => `${k} ${v}`).join(', ')}; ${pilots.filter((p) => p.sex === 'F').length} women`);
