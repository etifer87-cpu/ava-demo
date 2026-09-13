#!/usr/bin/env node
/**
 * seed-history.mjs - three years of training history for the roster.
 *
 *   npm run gen:history          plan only: writes data/history/plan-summary.json and
 *                                data/history/patterns.json (who carries which planted pattern),
 *                                touches no database
 *   npm run seed:history         plan + write, idempotent: a session already written (matched by
 *                                its plan id in sessions.setup) is skipped
 *   npm run seed:history -- --reset   voids every generated session first, then rewrites
 *   npm run seed:history -- --reset-initial   voids only the initial-training courses' sessions, then rewrites them
 *
 * Specified by docs/avianca/07_HISTORY_GENERATOR.md. Everything is drawn from policy.yaml
 * `history` (section 11) and the seed there; the roster comes from data/roster/pilots.json and the
 * programs from data/programs/*.json, resolved against the PUBLISHED version of each program in
 * the database. Deterministic: same policy, same roster, same programs, same history. No real
 * person and no real record; every remark is from the neutral phrase bank below.
 *
 * What one finalized session writes (the kit's own tables, migrations 0024-0030):
 *   sessions (setup.plan_id, both signature times), session_subjects per pilot, element_grades
 *   per graded exercise (every attempt a row), competency_grades + competency_grade_obs per
 *   competency the program targets, then the frozen records + record_tasks + record_competencies
 *   with a snapshot that renders the record without the template, and line_sectors for the line.
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { addDays, addMonths, argFlag, connect, isoDate, KIT_ROOT, loadPolicy, makeRng, parseDate } from './lib/kit-seed.mjs';

const policy = (await loadPolicy()).data;
const H = policy.history;
if (!H) { console.error('policy.yaml has no history section'); process.exit(1); }
const PLAN_ONLY = argFlag('--plan');
const RESET = argFlag('--reset');
const RESET_INITIAL = argFlag('--reset-initial');
const FROM = parseDate(H.from);
const AS_OF = parseDate(H.as_of);
const ROUTES = H.routes;

/* ------------------------------------------------------------------ inputs */

const roster = JSON.parse(await readFile(path.join(KIT_ROOT, 'data', 'roster', 'pilots.json'), 'utf8'));
const pilots = roster.pilots.filter((p) => p.roster_status === 'active' && !p.training_course);
const trainees = roster.pilots.filter((p) => p.roster_status === 'active' && p.training_course);
const candidates = roster.pilots.filter((p) => p.roster_status === 'candidate');
const PROG_DIR = path.join(KIT_ROOT, 'data', 'programs');
const programs = new Map();
for (const f of (await readdir(PROG_DIR)).filter((x) => x.endsWith('.json') && x !== 'retired.json')) {
  const def = JSON.parse(await readFile(path.join(PROG_DIR, f), 'utf8'));
  programs.set(def.template.code, { def, graded: gradedExercises(def), competencies: new Set(def.competencies_default ?? []) });
}
/** The graded exercises of a program, in order, with what they grade. */
function gradedExercises(def) {
  const out = [];
  const walk = (els, trainingOnly) => els.forEach((e) => {
    const to = trainingOnly || e.content?.training_only === true;
    if (e.type === 'task' && !to) {
      const g = e.content?.grading ?? {};
      if ((g.task_outcome_mode && g.task_outcome_mode !== 'none') || (g.competency_grade_mode && g.competency_grade_mode !== 'none')) {
        out.push({ key: e.key, title: e.title, task_mode: g.task_outcome_mode ?? 'none', comp_mode: g.competency_grade_mode ?? 'none', competencies: g.competencies ?? [], pf_pm: e.content?.pf_pm ?? null });
      }
    }
    walk(e.children ?? [], to);
  });
  walk(def.elements, false);
  return out;
}

/* ------------------------------------------------------------------ the population model */

const rng = makeRng(H.seed, 'history');
const gaussFrom = (r) => () => { let u = 0; let v = 0; while (u === 0) u = r.next(); while (v === 0) v = r.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const gaussLine = gaussFrom(rng);
const gauss = gaussLine;
// Initial-training trainees draw from their own stream, so adding a course never moves a line pilot's history.
const rngInitial = makeRng(H.seed, 'initial-training');
const gaussInitial = gaussFrom(rngInitial);
const COMPS = ['KNO', 'PRO', 'COM', 'FPA', 'FPM', 'LTW', 'PSD', 'SAW', 'WLM'];
const byId = new Map(roster.pilots.map((p) => [p.external_id, p]));

// Latent ability per competency; instructor bias; planted patterns.
const model = new Map();
for (const p of roster.pilots) {
  const ability = {};
  const g = p.training_course ? gaussInitial : gauss;
  const base = H.grades.mean + g() * H.grades.pilot_sd - (p.training_course ? 0.35 : 0);
  for (const c of COMPS) ability[c] = base + g() * 0.18 + (p.fleet === 'B787' ? (c === 'KNO' ? 0.12 : c === 'FPM' ? -0.12 : 0) : 0);
  model.set(p.external_id, { ability, bias: 0, obHabit: null, decline: null });
}
const patterns = { declining: [], strict: null, lenient: null, habits: [], wlm_revision_from: H.patterns.wlm_revision_from, clo_scenario_year: H.patterns.clo_weak_year };
const pick = (pool, n) => rng.sample(pool, n);
for (const p of pick([pilots.find((x) => x.fleet === 'A320' && x.position === 'CP' && !x.instructor_roles.length), pilots.find((x) => x.fleet === 'A320' && x.position === 'FO' && x.seniority > 320), pilots.find((x) => x.fleet === 'B787' && x.position === 'FO')].filter(Boolean), 3)) {
  model.get(p.external_id).decline = { from: parseDate(H.patterns.decline_from), perMonth: -H.patterns.decline_per_month, comps: ['FPM', 'SAW'] };
  patterns.declining.push({ seniority: p.seniority, name: p.full_name, fleet: p.fleet, position: p.position });
}
const examiners = pilots.filter((p) => p.instructor_roles.includes('TRE'));
const tris = pilots.filter((p) => p.instructor_roles.includes('TRI') && !p.instructor_roles.includes('TRE'));
{
  const strict = pick(examiners.filter((p) => p.fleet === 'A320'), 1)[0]; model.get(strict.external_id).bias = -H.patterns.strict_bias; patterns.strict = { seniority: strict.seniority, name: strict.full_name };
  const lenient = pick(tris.filter((p) => p.fleet === 'A320'), 1)[0]; model.get(lenient.external_id).bias = H.patterns.lenient_bias; patterns.lenient = { seniority: lenient.seniority, name: lenient.full_name };
  for (const h of pick(tris.filter((p) => p.external_id !== lenient.external_id), 2)) { model.get(h.external_id).obHabit = 'COM'; patterns.habits.push({ seniority: h.seniority, name: h.full_name, competency: 'COM' }); }
}

/* ------------------------------------------------------------------ the calendar */

const plans = [];
let planSeq = 0;
const planId = (kind, a, b) => `${H.seed}:${kind}:${a}:${b ?? planSeq++}`;
const monthDay = (year, month, spread) => { const d = parseDate(`${year}-${String(month).padStart(2, '0')}-01`); return addDays(d, spread); };
const weekday = (d) => { const w = d.getUTCDay(); return w === 0 ? addDays(d, 1) : w === 6 ? addDays(d, 2) : d; };
const active = (p, date) => parseDate(p.joined_on) <= addDays(date, -H.new_hire_grace_days);

// Crews: within a fleet and a start month, captains and first officers are paired for EBT and OPC/LPC.
const years = []; for (let y = FROM.getUTCFullYear(); y <= AS_OF.getUTCFullYear(); y += 1) years.push(y);
for (const fleet of ['A320', 'B787']) {
  for (let m0 = 1; m0 <= 6; m0 += 1) {
    const group = pilots.filter((p) => p.fleet === fleet && (p.seniority % 6) + 1 === m0);
    const cps = group.filter((p) => p.position === 'CP'); const fos = group.filter((p) => p.position === 'FO');
    const crews = [];
    while (cps.length && fos.length) crews.push([cps.shift(), fos.shift()]);
    const rest = [...cps, ...fos]; while (rest.length) crews.push(rest.splice(0, 2));
    for (const year of years) for (const module of [1, 2]) {
      const month = m0 + (module - 1) * 6;
      for (const [ci, crew] of crews.entries()) {
        const day1 = weekday(monthDay(year, month, (ci * 7 + rng.int(0, 3)) % 26));
        const subjects = crew.filter((p) => active(p, day1));
        if (!subjects.length) continue;
        for (const session of [1, 2]) {
          const date = addDays(day1, session - 1);
          plans.push({ id: planId('ebt', `${fleet}-${year}-m${module}-s${session}-${m0}-${ci}`, ''), kind: 'ebt', program: `ebt.${fleet.toLowerCase()}.${year}.m${module}.s${session}`, fleet, date, subjects: subjects.map((s) => s.external_id), pool: 'instructor' });
        }
        if (module === 2) plans.push({ id: planId('pc', `${fleet}-${year}-${m0}-${ci}`, ''), kind: 'pc', program: `pc.${fleet.toLowerCase()}.${year}`, fleet, date: addDays(day1, 2), subjects: subjects.map((s) => s.external_id), pool: 'examiner', check: year % 2 === 0 ? 'LPC' : 'OPC' });
      }
    }
  }
  // Ground school: first quarter, groups of twelve, per fleet and year.
  for (const year of years) {
    const list = pilots.filter((p) => p.fleet === fleet && active(p, parseDate(`${year}-03-31`)));
    for (let i = 0; i < list.length; i += 12) {
      const date = weekday(monthDay(year, 1 + Math.floor((i / 12) % 3), (Math.floor(i / 36) * 3 + rng.int(0, 2)) % 27));
      plans.push({ id: planId('gs', `${fleet}-${year}-${i / 12}`, ''), kind: 'gs', program: `gs.${fleet.toLowerCase()}.${year}`, fleet, date, subjects: list.slice(i, i + 12).map((s) => s.external_id), pool: 'ground' });
    }
  }
}
// Line checks: yearly, spread by seniority.
for (const p of pilots) for (const year of years) {
  const date = weekday(monthDay(year, (p.seniority % 12) + 1, (p.seniority * 7) % 27));
  if (active(p, date)) plans.push({ id: planId('lc', `${p.external_id}-${year}`, ''), kind: 'lc', program: 'lc.line-check', fleet: p.fleet, date, subjects: [p.external_id], pool: 'examiner', route: rng.pick(ROUTES[p.fleet]) });
}
// LFUS: after an upgrade or a fleet change inside the period, then a line check.
for (const p of pilots) {
  const since = parseDate(p.rank_since); const fleetSince = parseDate(p.fleet_since);
  const start = since >= FROM ? since : fleetSince >= FROM ? fleetSince : null;
  if (!start) continue;
  const newHire = p.rank_since === p.joined_on;
  const n = newHire ? H.lfus.sectors_after_hire : since >= FROM ? H.lfus.sectors_after_upgrade : H.lfus.sectors_after_fleet_change;
  const ltcPool = 'ltc';
  for (let s = 1; s <= n; s += 1) {
    const date = weekday(addDays(start, 3 + Math.floor((s - 1) * (42 / n))));
    plans.push({ id: planId('lfus', `${p.external_id}-${s}`, ''), kind: 'lfus', program: 'lfus.sector', fleet: p.fleet, date, subjects: [p.external_id], pool: ltcPool, sector: s, route: ROUTES[p.fleet][(p.seniority + s) % ROUTES[p.fleet].length], pfOdd: s % 2 === 1 });
  }
  plans.push({ id: planId('lc', `${p.external_id}-upgrade`, ''), kind: 'lc', program: 'lc.line-check', fleet: p.fleet, date: weekday(addDays(start, 56)), subjects: [p.external_id], pool: 'examiner', route: ROUTES[p.fleet][p.seniority % ROUTES[p.fleet].length] });
}
// Screening: candidates, 2026.
for (const [i, c] of candidates.entries()) {
  plans.push({ id: planId('screen', c.external_id, ''), kind: 'screen', program: 'screen.a320', fleet: 'A320', date: weekday(monthDay(AS_OF.getUTCFullYear(), 5 + Math.floor(i / 6), (i * 4) % 27)), subjects: [c.external_id], pool: 'examiner', screening: i < 3 ? 'RECOMMENDED' : i < 5 ? 'NOT RECOMMENDED' : 'PENDING' });
}
// Initial training: the type-rating pipeline per course, from the course start date. Sessions after
// as_of stay planned, which is how the training-status page knows the stage each course is at.
{
  const T = H.initial_training;
  const courses = new Map();
  for (const t of trainees) { if (!courses.has(t.training_course)) courses.set(t.training_course, []); courses.get(t.training_course).push(t); }
  for (const [code, members] of courses) {
    const start = parseDate(members[0].joined_on); const fleet = members[0].fleet; const year = start.getUTCFullYear();
    const ids = members.map((m) => m.external_id);
    plans.push({ id: planId('trg', code, ''), kind: 'gs', program: `tr.${fleet.toLowerCase()}.${year}.ground`, fleet, date: weekday(addDays(start, T.ground_days)), subjects: ids, pool: 'ground', course: code, stage: 'ground' });
    const crews = []; for (let i = 0; i < members.length; i += 2) crews.push(members.slice(i, i + 2));
    let day = T.ground_days;
    for (let n = 1; n <= T.ffs_sessions; n += 1) {
      day += T.ffs_every_days;
      for (const [ci, crew] of crews.entries()) plans.push({ id: planId('trffs', `${code}-${n}-${ci}`, ''), kind: 'trffs', program: `tr.${fleet.toLowerCase()}.${year}.ffs${n}`, fleet, date: weekday(addDays(start, day + (ci % 2))), subjects: crew.map((m) => m.external_id), pool: 'instructor', course: code, stage: 'simulator', session: n });
    }
    day += T.skill_test_after_days;
    for (const [ci, crew] of crews.entries()) plans.push({ id: planId('trpc', `${code}-${ci}`, ''), kind: 'pc', program: `pc.${fleet.toLowerCase()}.${year}`, fleet, date: weekday(addDays(start, day + (ci % 2))), subjects: crew.map((m) => m.external_id), pool: 'examiner', check: 'LPC', course: code, stage: 'skill_test' });
    for (const m of members) {
      let d = day + T.skill_test_after_days;
      // Each pilot flies at their own cadence inside lfus_every_days_range (by seniority, so it is stable), which is
      // what fans a course out across line training, line check and release rather than moving it as one block.
      const range = T.lfus_every_days_range;
      const every = range ? range[0] + (m.seniority % (range[1] - range[0] + 1)) : T.lfus_every_days;
      for (let sct = 1; sct <= T.lfus_sectors; sct += 1) {
        d += every;
        plans.push({ id: planId('trlfus', `${m.external_id}-${sct}`, ''), kind: 'lfus', program: 'lfus.sector', fleet, date: weekday(addDays(start, d)), subjects: [m.external_id], pool: 'ltc', sector: sct, route: ROUTES[fleet][(m.seniority + sct) % ROUTES[fleet].length], pfOdd: sct % 2 === 1, course: code, stage: 'lfus' });
      }
      plans.push({ id: planId('trlc', m.external_id, ''), kind: 'lc', program: 'lc.line-check', fleet, date: weekday(addDays(start, d + T.line_check_after_days)), subjects: [m.external_id], pool: 'examiner', route: ROUTES[fleet][m.seniority % ROUTES[fleet].length], course: code, stage: 'line_check' });
    }
  }
}
plans.sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
const planned = plans.filter((p) => p.date > AS_OF);
const flown = plans.filter((p) => p.date <= AS_OF && p.date >= FROM);

/* ------------------------------------------------------------------ assessors */

const pools = {
  instructor: (fleet) => pilots.filter((p) => p.fleet === fleet && p.instructor_roles.some((r) => ['TRI', 'SFI', 'TRE', 'SFE'].includes(r))),
  examiner: (fleet) => pilots.filter((p) => p.fleet === fleet && p.instructor_roles.some((r) => ['TRE', 'SFE'].includes(r))),
  ltc: (fleet) => pilots.filter((p) => p.fleet === fleet && p.instructor_roles.includes('LTC')),
  ground: (fleet) => pilots.filter((p) => p.instructor_roles.includes('GI')),
};
const usual = new Map();
function assessorFor(plan) {
  const pool = pools[plan.pool](plan.fleet).filter((a) => !plan.subjects.includes(a.external_id));
  if (!pool.length) throw new Error(`no ${plan.pool} available on ${plan.fleet} for ${plan.id}`);
  const key = `${plan.subjects[0]}:${plan.pool}`;
  if (!usual.has(key)) usual.set(key, rng.pick(pool).external_id);
  const u = byId.get(usual.get(key));
  const a = pool.some((x) => x.external_id === u.external_id) && rng.chance(H.assessors.usual_share) ? u : rng.pick(pool);
  return a;
}

/* ------------------------------------------------------------------ grades */

const PHRASES = {
  low: { KNO: 'Procedure knowledge needs consolidation; review the QRH items discussed.', PRO: 'Checklist discipline slipped under workload; the flow was completed late.', COM: 'Calls were late or incomplete; the intent was not always shared with the PM.', FPA: 'Automation mode changes not announced; FMA monitoring below standard.', FPM: 'Manual handling below standard: pitch and speed control on the approach.', LTW: 'Workload was carried alone; the PM was not used.', PSD: 'The decision came late and without the options being weighed.', SAW: 'Lost the picture during the failure; the position was not monitored.', WLM: 'Tasks were not prioritised; the checklist was started at the wrong time.' },
  mid: { KNO: 'Sound knowledge of the procedures used.', PRO: 'Procedures applied as published.', COM: 'Clear, standard communication.', FPA: 'Automation managed as briefed.', FPM: 'Handling within standard throughout.', LTW: 'Worked as a crew; shared the load.', PSD: 'Sound decision, reached in time.', SAW: 'Maintained the picture through the failure.', WLM: 'Workload managed; nothing left behind.' },
  high: { KNO: 'Excellent systems knowledge, applied to the situation.', PRO: 'Exemplary procedure discipline under pressure.', COM: 'Communication kept everyone ahead of the aircraft.', FPA: 'Automation used precisely and announced every time.', FPM: 'Accurate, smooth handling in every configuration.', LTW: 'Led the crew calmly; used the PM well.', PSD: 'Weighed the options and decided early; the plan held.', SAW: 'Anticipated the threats and briefed them before they arrived.', WLM: 'Prioritised well and kept capacity in hand.' },
};
const GRADES_C = ['C', 'NC'];

function competencyDraw(plan, subjectId, assessor, comp, date) {
  const m = model.get(subjectId); const a = model.get(assessor.external_id);
  const g = plan.course ? gaussInitial : gaussLine;
  let x = m.ability[comp] + a.bias + g() * H.grades.session_sd;
  if (m.decline && date >= m.decline.from && m.decline.comps.includes(comp)) x += m.decline.perMonth * ((date - m.decline.from) / (30.4 * 86400000));
  if (comp === 'WLM' && date >= parseDate(H.patterns.wlm_revision_from)) x += H.patterns.wlm_gain;
  return x;
}
const clip = (x) => Math.max(1, Math.min(5, Math.round(x)));

function gradeSession(plan, subject, assessor) {
  const prog = programs.get(plan.program);
  const p = byId.get(subject);
  const gauss = plan.course ? gaussInitial : gaussLine;
  const tasks = []; const comps = new Map(); let failed = 0;
  // One latent per competency for the session; tasks read their focus competencies.
  const latent = {}; for (const c of COMPS) latent[c] = competencyDraw(plan, subject, assessor, c, plan.date);
  for (const [i, ex] of prog.graded.entries()) {
    const focus = ex.competencies.length ? ex.competencies : ['FPM', 'PRO'];
    let x = focus.reduce((s, c) => s + latent[c], 0) / focus.length + gauss() * 0.3;
    if (plan.kind === 'ebt' && p.base === 'CLO' && plan.date.getUTCFullYear() === H.patterns.clo_weak_year && /fuel/i.test(ex.title)) x -= H.patterns.clo_penalty;
    if (ex.task_mode === 'scale_1_5') {
      const g = clip(x);
      tasks.push({ key: ex.key, title: ex.title, position: i, attempt: 1, grade: String(g), remark: g <= 2 ? PHRASES.low[focus[0]] : g === 5 ? PHRASES.high[focus[0]] : null, pf_pm: ex.pf_pm });
      if (g <= 2) failed += 1;
    } else if (ex.task_mode === 'pass_fail') {
      const pass = x >= H.rates.fail_below;
      tasks.push({ key: ex.key, title: ex.title, position: i, attempt: 1, grade: pass ? 'PASS' : 'FAIL', remark: pass ? null : PHRASES.low[focus[0]], pf_pm: ex.pf_pm });
      if (!pass) { failed += 1; if (rng.chance(H.rates.repeat_passes)) tasks.push({ key: ex.key, title: ex.title, position: i, attempt: 2, grade: 'PASS', remark: 'Repeated to standard.', pf_pm: ex.pf_pm }); }
    }
    for (const c of ex.competencies) {
      const cur = comps.get(c);
      if (ex.comp_mode === 'scale_1_5') comps.set(c, { mode: 'scale', grade: clip(latent[c] + gauss() * 0.2) });
      else if (!cur) comps.set(c, { mode: 'cnc', grade: latent[c] >= 2.5 ? 'C' : 'NC' });
    }
  }
  return { tasks, comps, failed, latent };
}

function outcomeFor(plan, graded) {
  const scale = [...graded.comps.values()].filter((c) => c.mode === 'scale').map((c) => c.grade);
  const ones = scale.filter((g) => g === 1).length; const twos = scale.filter((g) => g === 2).length;
  const fails = graded.tasks.filter((t) => t.grade === 'FAIL').length;
  const repeatedOk = graded.tasks.filter((t) => t.attempt === 2).length;
  switch (plan.kind) {
    case 'ebt': return ones > 0 || twos >= H.rates.not_proficient_twos ? 'NOT PROFICIENT' : 'PROFICIENT';
    case 'trffs': return graded.tasks.filter((t) => Number(t.grade) <= 2).length >= 2 ? 'REPEAT' : 'PROGRESS';
    case 'pc': return fails - repeatedOk > 0 ? 'FAIL' : fails > 0 || ones > 0 ? 'PARTIAL PASS' : 'PASS';
    case 'lc': return ones > 0 || twos >= H.rates.line_check_fail_twos ? 'FAIL' : 'PASS';
    case 'gs': return graded.tasks.filter((t) => Number(t.grade) <= 2).length >= 4 ? 'NOT PROFICIENT' : 'PROFICIENT';
    case 'lfus': return null;
    case 'screen': return plan.screening;
    default: return 'PASS';
  }
}

/* ------------------------------------------------------------------ plan only */

const summary = {
  seed: H.seed, from: H.from, as_of: H.as_of, pilots: pilots.length, candidates: candidates.length,
  sessions_flown: flown.length, sessions_planned: planned.length,
  by_kind: Object.fromEntries(['ebt', 'pc', 'gs', 'lc', 'lfus', 'screen', 'trffs'].map((k) => [k, flown.filter((p) => p.kind === k).length])),
  initial_training: Object.fromEntries([...new Set(plans.filter((p) => p.course).map((p) => p.course))].map((c) => [c, { flown: flown.filter((p) => p.course === c).length, planned: planned.filter((p) => p.course === c).length, stage: (flown.filter((p) => p.course === c).at(-1)?.stage ?? 'not started') }])),
  records_expected: flown.reduce((n, p) => n + p.subjects.length, 0),
};
await mkdir(path.join(KIT_ROOT, 'data', 'history'), { recursive: true });
await writeFile(path.join(KIT_ROOT, 'data', 'history', 'plan-summary.json'), JSON.stringify(summary, null, 2) + '\n');
await writeFile(path.join(KIT_ROOT, 'data', 'history', 'patterns.json'), JSON.stringify({ note: 'Planted patterns the analytics should find. Generated by scripts/seed-history.mjs; nobody real.', ...patterns }, null, 2) + '\n');
console.log(`plan: ${flown.length} sessions flown (${Object.entries(summary.by_kind).map(([k, n]) => `${k} ${n}`).join(', ')}), ${planned.length} planned, ~${summary.records_expected} records`);
if (PLAN_ONLY) {
  // Grade distribution and outcomes, so a policy change can be judged before a database is touched.
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; const outcomes = {}; let n = 0;
  for (const plan of flown) {
    const a = assessorFor(plan);
    for (const s of plan.subjects) { const g = gradeSession(plan, s, a); for (const c of g.comps.values()) if (c.mode === 'scale') dist[c.grade] += 1; const o = `${plan.kind}:${outcomeFor(plan, g) ?? 'none'}`; outcomes[o] = (outcomes[o] ?? 0) + 1; n += 1; }
  }
  const tot = Object.values(dist).reduce((x, y) => x + y, 0);
  console.log(`grades 1-5: ${Object.entries(dist).map(([k, v]) => `${k} ${(100 * v / tot).toFixed(1)}%`).join(' · ')} (${tot} competency grades over ${n} records)`);
  console.log(`outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  process.exit(0);
}

/* ------------------------------------------------------------------ write */

const client = await connect();
const ins = async (table, cols, rows, conflict = 'ON CONFLICT DO NOTHING', returning = '') => {
  const out = [];
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const values = chunk.map((r, ri) => `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`).join(',');
    const res = await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values} ${conflict} ${returning ? `RETURNING ${returning}` : ''}`, chunk.flat());
    out.push(...res.rows);
  }
  return out;
};
try {
  const framework = (await client.query(`SELECT id, code FROM competency_frameworks WHERE is_active`)).rows[0];
  if (!framework) throw new Error('no active competency framework; run seed:framework');
  const compRows = (await client.query(`SELECT c.id, c.code, c.name FROM competencies c WHERE c.framework_id = $1::uuid AND c.is_active`, [framework.id])).rows;
  const compByCode = new Map(compRows.map((c) => [c.code, c]));
  const obRows = (await client.query(`SELECT ob.id, ob.code, ob.text, c.code AS comp FROM observable_behaviours ob JOIN competencies c ON c.id = ob.competency_id WHERE ob.framework_id = $1::uuid AND ob.is_active ORDER BY ob.position`, [framework.id])).rows;
  const obsByComp = new Map(); for (const ob of obRows) { if (!obsByComp.has(ob.comp)) obsByComp.set(ob.comp, []); obsByComp.get(ob.comp).push(ob); }
  const versions = new Map((await client.query(`SELECT t.code, v.id, t.name, t.template_kind, k.label, k.facility_kind, v.hide_record_from_subject FROM session_templates t JOIN session_template_versions v ON v.id = t.current_version_id LEFT JOIN template_kinds k ON k.code = t.template_kind WHERE t.deleted_at IS NULL AND v.status = 'published'`)).rows.map((r) => [r.code, r]));
  for (const code of new Set(plans.map((p) => p.program))) if (!versions.has(code)) throw new Error(`program ${code} has no published version; run npm run publish:programs (or publish it in the builder) first`);
  const people = new Map((await client.query(`SELECT id, external_id, full_name, position, org_unit_id, asset_class_id FROM people WHERE deleted_at IS NULL`)).rows.map((r) => [r.external_id, r]));
  for (const p of roster.pilots) if (!people.has(p.external_id)) throw new Error(`${p.external_id} is not in people; run seed:roster`);
  const orgByCode = new Map((await client.query(`SELECT id, code FROM org_units WHERE deleted_at IS NULL`)).rows.map((r) => [r.code, r.id]));
  const assetByCode = new Map((await client.query(`SELECT id, code FROM asset_classes WHERE deleted_at IS NULL`)).rows.map((r) => [r.code, r.id]));
  const facility = { ffs: (f) => `FFS-${f}`, classroom: () => 'Training centre, Bogotá', line: () => 'Line', aircraft: () => 'Line', other: (f) => `FFS-${f}` };

  await client.query('BEGIN');
  if (RESET) {
    const { rowCount } = await client.query(`UPDATE sessions SET status = 'void', deleted_at = now() WHERE setup->>'plan_seed' = $1 AND deleted_at IS NULL`, [H.seed]);
    await client.query(`UPDATE records SET deleted_at = now() WHERE deleted_at IS NULL AND snapshot->>'plan_seed' = $1`, [H.seed]);
    console.log(`reset: ${rowCount} generated sessions voided`);
  } else if (RESET_INITIAL) {
    await client.query(`UPDATE records r SET deleted_at = now() FROM sessions s WHERE r.session_id = s.id AND r.deleted_at IS NULL AND s.setup->>'plan_seed' = $1 AND s.setup ? 'course'`, [H.seed]);
    const { rowCount } = await client.query(`UPDATE sessions SET status = 'void', deleted_at = now() WHERE setup->>'plan_seed' = $1 AND setup ? 'course' AND deleted_at IS NULL`, [H.seed]);
    console.log(`reset-initial: ${rowCount} initial-training sessions voided`);
  }
  const existing = new Set((await client.query(`SELECT setup->>'plan_id' AS id FROM sessions WHERE setup->>'plan_seed' = $1 AND deleted_at IS NULL`, [H.seed])).rows.map((r) => r.id));
  const counts = { sessions: 0, records: 0, tasks: 0, comps: 0, obs: 0, sectors: 0, objections: 0, skipped: 0, planned: 0 };

  for (const plan of [...flown, ...planned]) {
    if (existing.has(plan.id)) { counts.skipped += 1; continue; }
    const v = versions.get(plan.program);
    const assessor = assessorFor(plan);
    const isPlanned = plan.date > AS_OF;
    const date = isoDate(plan.date);
    const signAt = `${date}T${plan.kind === 'gs' ? '17:30' : '16:45'}:00Z`;
    const subjectsGraded = isPlanned ? [] : plan.subjects.map((s) => ({ s, g: gradeSession(plan, s, assessor) }));
    const objected = !isPlanned && plan.kind !== 'screen' && rng.chance(H.rates.objection) ? subjectsGraded[0] : null;
    const setup = { plan_seed: H.seed, plan_id: plan.id, kind: plan.kind, ...(plan.course ? { course: plan.course, stage: plan.stage, session_number: plan.session ?? null } : {}), ...(plan.check ? { check: plan.check } : {}), ...(plan.route ? { departure: plan.route[0], arrival: plan.route[1], aircraft_type: plan.fleet, registration: plan.fleet === 'B787' ? 'N787AV' : 'N320AV' } : {}), ...(plan.sector ? { sector_number: plan.sector } : {}), ...(objected ? { objection: { reason: 'The grade on the second sector does not reflect what was flown; the failure was inserted before the briefing was complete.', by: people.get(objected.s).full_name, at: `${date}T18:10:00Z` } } : {}) };
    const status = isPlanned ? 'in_progress' : objected ? 'submitted' : 'finalized';
    const { rows: srows } = await client.query(
      `INSERT INTO sessions (template_version_id, framework_id, org_unit_id, asset_class_id, session_date, facility, facility_kind, assessor_person_id, status, outcome, remarks, setup, assessor_signed_at, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6,$7,$8::uuid,$9,$10,$11,$12::jsonb,$13,$14) RETURNING id`,
      [v.id, framework.id, orgByCode.get(byId.get(plan.subjects[0]).base ?? 'BOG') ?? null, assetByCode.get(plan.fleet) ?? null, date, facility[v.facility_kind ?? 'ffs'](plan.fleet), v.facility_kind ?? 'ffs', people.get(assessor.external_id).id, status,
       isPlanned ? null : plan.subjects.length === 1 ? outcomeFor(plan, subjectsGraded[0].g) : null, isPlanned ? null : plan.kind === 'ebt' ? 'Session conducted and debriefed against the published program.' : null, JSON.stringify(setup), isPlanned ? null : signAt, `${date}T08:00:00Z`],
    );
    const sessionId = srows[0].id; counts.sessions += 1; if (isPlanned) counts.planned += 1;
    if (objected) counts.objections += 1;

    for (const [si, s] of plan.subjects.entries()) {
      const person = people.get(s); const pr = byId.get(s);
      const graded = subjectsGraded.find((x) => x.s === s)?.g ?? null;
      const outcome = graded ? (objected && objected.s === s ? 'INCOMPLETE' : outcomeFor(plan, graded)) : null;
      const seat = plan.kind === 'lfus' ? (plan.pfOdd ? 'PF' : 'PM') : si === 0 ? 'PF' : 'PM';
      await client.query(`INSERT INTO session_subjects (session_id, person_id, seat_role, is_assessed, outcome, subject_signed_at) VALUES ($1::uuid,$2::uuid,$3,true,$4,$5) ON CONFLICT DO NOTHING`,
        [sessionId, person.id, seat, outcome, graded && !(objected && objected.s === s) && !v.hide_record_from_subject ? `${date}T17:00:00Z` : null]);
      if (!graded) continue;
      const gradedBy = null;
      await ins('element_grades', ['session_id', 'person_id', 'element_key', 'instance_no', 'attempt', 'grade', 'remark', 'graded_at', 'graded_by'],
        graded.tasks.map((t) => [sessionId, person.id, t.key, 1, t.attempt, t.grade, t.remark, `${date}T12:00:00Z`, gradedBy]), 'ON CONFLICT (session_id, person_id, element_key, instance_no, attempt) DO NOTHING');
      counts.tasks += graded.tasks.length;
      const compEntries = [...graded.comps.entries()];
      const obPicks = new Map();
      const cg = await ins('competency_grades', ['session_id', 'person_id', 'framework_id', 'competency_id', 'grade', 'remark', 'graded_at', 'graded_by'],
        compEntries.map(([code, c]) => {
          const g = c.mode === 'scale' ? c.grade : c.grade;
          const remark = c.mode === 'scale' ? (c.grade <= 2 ? PHRASES.low[code] : c.grade >= 5 ? PHRASES.high[code] : rng.chance(0.25) ? PHRASES.mid[code] : null) : c.grade === 'NC' ? PHRASES.low[code] : null;
          const obs = obsByComp.get(code) ?? [];
          const habit = model.get(assessor.external_id).obHabit === code;
          const n = c.mode === 'scale' ? (c.grade >= 4 ? rng.int(2, 3) : c.grade <= 2 ? rng.int(1, 2) : rng.chance(0.5) ? 1 : 0) : c.grade === 'NC' ? 1 : 0;
          obPicks.set(code, habit ? obs.slice(0, Math.min(2, obs.length)) : rng.sample(obs, Math.min(n, obs.length)));
          return [sessionId, person.id, framework.id, compByCode.get(code).id, String(g), remark, `${date}T12:00:00Z`, gradedBy];
        }), 'ON CONFLICT (session_id, person_id, competency_id) DO NOTHING', 'id, competency_id');
      counts.comps += compEntries.length;
      const cgByComp = new Map(cg.map((r) => [r.competency_id, r.id]));
      const obRowsToInsert = [];
      for (const [code, obs] of obPicks) { const gid = cgByComp.get(compByCode.get(code).id); if (gid) for (const ob of obs) obRowsToInsert.push([gid, ob.id]); }
      if (obRowsToInsert.length) await ins('competency_grade_obs', ['competency_grade_id', 'observable_behaviour_id'], obRowsToInsert);
      counts.obs += obRowsToInsert.length;

      // The frozen record.
      const snapshot = {
        plan_seed: H.seed, plan_id: plan.id, kind: plan.kind,
        tasks: graded.tasks.map((t) => ({ element_key: t.key, task_name: t.title, external_ref: null, attempt: t.attempt, grade: t.grade, remark: t.remark, pf_pm: t.pf_pm, role: t.pf_pm ? seat : null })),
        competency_scores: compEntries.filter(([, c]) => c.mode === 'scale').map(([code, c]) => ({ code, name: compByCode.get(code).name, score: c.grade })),
        competency_results: compEntries.filter(([, c]) => c.mode === 'cnc').map(([code, c]) => ({ code, name: compByCode.get(code).name, result: c.grade })),
        competency_remarks: compEntries.map(([code, c]) => ({ code, remark: c.mode === 'scale' ? (c.grade <= 2 ? PHRASES.low[code] : c.grade >= 5 ? PHRASES.high[code] : null) : null })).filter((x) => x.remark),
        observable_behaviours: [...obPicks.entries()].flatMap(([code, obs]) => obs.map((ob) => ({ competency: code, code: ob.code, text: ob.text }))),
        template: { code: plan.program, name: v.name, version_id: v.id, kind: v.template_kind, kind_label: v.label },
        framework: { code: framework.code },
        subject: { external_id: s, full_name: person.full_name, position: person.position, seat },
        assessor: { external_id: assessor.external_id, full_name: assessor.full_name, roles: assessor.instructor_roles },
        session: { date, facility: facility[v.facility_kind ?? 'ffs'](plan.fleet), ...(plan.check ? { check: plan.check } : {}), ...(plan.route ? { departure: plan.route[0], arrival: plan.route[1], aircraft_type: plan.fleet } : {}), ...(plan.sector ? { sector_number: plan.sector } : {}) },
        signatures: { assessor_at: signAt, subject_at: objected && objected.s === s ? null : v.hide_record_from_subject ? null : `${date}T17:00:00Z` },
        ...(objected && objected.s === s ? { objection: setup.objection } : {}),
        outcome, additional_training: outcome === 'NOT PROFICIENT',
        generated_by: 'scripts/seed-history.mjs',
      };
      const { rows: rrows } = await client.query(
        `INSERT INTO records (session_id, person_id, source, record_kind, title, template_version_id, framework_id, org_unit_id, asset_class_id, training_date, assessor_person_id, outcome, remarks, snapshot, is_hidden_from_subject, created_at)
         VALUES ($1::uuid,$2::uuid,'app',$3,$4,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::date,$10::uuid,$11,$12,$13::jsonb,$14,$15) ON CONFLICT DO NOTHING RETURNING id`,
        [sessionId, person.id, v.label ?? v.template_kind, `${v.name} - ${date} - ${s}`, v.id, framework.id, person.org_unit_id, plan.kind === 'lc' || plan.kind === 'lfus' ? assetByCode.get(plan.fleet) : person.asset_class_id, date, people.get(assessor.external_id).id, outcome,
         outcome === 'NOT PROFICIENT' ? 'Additional training recommended; see the competency remarks.' : null, JSON.stringify(snapshot), v.hide_record_from_subject === true, signAt]);
      const recordId = rrows[0]?.id; if (!recordId) continue;
      counts.records += 1;
      await ins('record_tasks', ['record_id', 'element_key', 'external_ref', 'task_name', 'position', 'instance_no', 'attempt', 'grade', 'remark'],
        graded.tasks.map((t) => [recordId, t.key, null, t.title, t.position, 1, t.attempt, t.grade, t.remark]), 'ON CONFLICT (record_id, element_key, instance_no, attempt) DO NOTHING');
      await ins('record_competencies', ['record_id', 'framework_id', 'competency_id', 'grade', 'remark', 'observable_behaviour_ids'],
        compEntries.map(([code, c]) => [recordId, framework.id, compByCode.get(code).id, String(c.grade), c.mode === 'scale' && c.grade <= 2 ? PHRASES.low[code] : null, (obPicks.get(code) ?? []).map((ob) => ob.id)]), 'ON CONFLICT (record_id, competency_id) DO NOTHING');
      if (plan.kind === 'lfus' || plan.kind === 'lc') {
        await client.query(`INSERT INTO line_sectors (session_id, record_id, person_id, sector_number, flight_ref, sector_date, departure, arrival, pf_role, is_supervised, outcome, remark) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::date,$7,$8,$9,$10,$11,NULL) ON CONFLICT (session_id, person_id, sector_number) DO NOTHING`,
          [sessionId, recordId, person.id, plan.sector ?? 1, `AV${String(7001 + (pr.seniority % 99)).slice(0, 4)}`, date, plan.route[0], plan.route[1], seat, plan.kind === 'lfus', outcome]);
        counts.sectors += 1;
      }
    }
    if (!isPlanned && !objected) await client.query(`UPDATE sessions SET computed_outcome = $2 WHERE id = $1::uuid`, [sessionId, plan.subjects.length === 1 ? outcomeFor(plan, subjectsGraded[0].g) : null]);
    if (counts.sessions % 500 === 0) console.log(`  ${counts.sessions} sessions written...`);
  }
  await client.query('COMMIT');
  // The assessor analytics are materialised (migration 0147); rebuild them so the bench reads what was just written.
  const t0 = Date.now();
  await client.query(`SET statement_timeout = 0`);
  await client.query(`SELECT refresh_assessor_analytics()`);
  console.log(`assessor analytics refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`history seeded: ${counts.sessions} sessions (${counts.planned} planned, ${counts.skipped} already present), ${counts.records} records, ${counts.tasks} task grades, ${counts.comps} competency grades, ${counts.obs} OB selections, ${counts.sectors} sectors, ${counts.objections} objections`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await client.end();
}
