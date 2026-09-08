/**
 * sessions.mjs - scheduling the events and writing them to the database.
 *
 * Split from events.mjs, which owns the grade draw and the outcome decision. This file owns WHEN
 * an event happens, WHO is in it, and the exact row shapes that land in the database.
 *
 * The writer is the part of the seed layer most worth reading twice: every INSERT here is the
 * INSERT the application performs, in the same order, with the same conflict handling. Where the
 * application writes one row per attempt, so does this. Where it freezes an array of objects into
 * records.snapshot, so does this. The moment the two diverge, every test written against seeded
 * data is testing something the platform does not do.
 */

import { NON_SCORING, decideOutcome, gradeSubject } from './events.mjs';

/* ------------------------------------------------------------------------- *
 * Scheduling
 * ------------------------------------------------------------------------- */

const TEMPLATE_WEIGHTS = [
  ['SEED-SIM-REC', 34],
  ['SEED-PROF-CHK', 18],
  ['SYN-LINE-CHK', 22],
  ['SEED-LINE-SUP', 14],
  ['SEED-GND-SCH', 12],
];

function weightedPick(rng, entries) {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.next() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

/**
 * Builds the session plan. Multi-subject events are real events: ground school fans a classroom
 * out into one record per subject, and a simulator detail carries two subjects in one session.
 * A generator that only ever produces one subject per session never exercises the fan-out path,
 * and the fan-out path is where the per-subject outcome lives.
 */
export function buildSchedule({
  policy, rng, population, templates, months, quiet, schedule, quarterSchedule, quarterKinds, cfg,
}) {
  const volume = policy.synthetic.volume;
  const eventRng = rng.fork('events');
  const events = [];

  // A ROTATION, NOT A BAG. Each round deals every assessor who still has volume left, so any
  // consecutive slice of the rotation carries a proportional mix of the roster instead of a
  // random one. Drawing independently per event gives each assessor the right SHARE and the
  // wrong DISTRIBUTION, and at these denominators - a period holds a handful of gradings - the
  // difference decides the metric: an assessor bias of +/- 1.2 grades swings a period's rate
  // further than any difficulty offset the schedule applies, so a period that happens to draw
  // the lenient outlier and not the severe one lands below target however hard the schedule
  // made it. The share is unchanged and the run is still byte-identical for a given --seed.
  const rotationRng = rng.fork('assessor-rotation');
  const slots = rotationRng.shuffle(population.assessors.map((a) => ({
    assessor: a, count: Math.max(1, Math.round((a.trait.volume ?? 1) * 10)),
  })));
  const assessorRotation = [];
  for (let round = 0; round < Math.max(...slots.map((s) => s.count)); round += 1) {
    for (const slot of slots) if (slot.count > round) assessorRotation.push(slot.assessor);
  }

  for (const subject of population.subjects) {
    const profile = subject.profile;
    const count = profile.sessions !== undefined
      ? profile.sessions
      : Math.max(2, Math.round(volume.sessions_per_subject_per_year * cfg.windowYears));
    if (count === 0) continue;

    const available = profile.historyOnly
      ? months.slice(0, Math.floor(months.length * 0.6))
      : months;
    const usable = available.filter((m) => !quiet.has(m));
    // EVENLY SPREAD, not randomly sampled. Random month sampling leaves holes, and a hole inside a
    // configured base window is a base period below suppression.min_n_rate - which drops that
    // period out of the base and makes base_periods disagree with the number the configuration
    // asserts on every base row. Recurrent training is periodic in reality anyway.
    const slots = Math.min(count, usable.length);
    const chosen = [];
    for (let slot = 0; slot < slots; slot += 1) {
      const from = Math.floor((slot * usable.length) / slots);
      const to = Math.max(from, Math.floor(((slot + 1) * usable.length) / slots) - 1);
      chosen.push(usable[eventRng.int(from, to)]);
    }
    chosen.sort();

    chosen.forEach((month, i) => {
      // The weight of a template belonging to a quarterly scope is scaled by that quarter's
      // volume factor, so how much line activity a quarter carries is a decision rather than an
      // accident. Everything else keeps its flat weight.
      const weights = TEMPLATE_WEIGHTS
        .filter(([code]) => templates.has(code))
        .map(([code, weight]) => [
          code,
          quarterKinds.has(templates.get(code).kind)
            ? weight * (quarterSchedule.get(month)?.volume ?? 1)
            : weight,
        ]);
      const templateCode = weightedPick(eventRng, weights);
      events.push({
        subject, month, templateCode, assessor: null,
        index: i, total: chosen.length,
        source: profile.source ?? (eventRng.chance(volume.import_share) ? 'import' : 'app'),
      });
    });
  }

  // Dealt in month order, and in a SEPARATE LANE per scope grain. A quarterly scope holds a
  // fraction of the events in any window, so a single lane would hand it a thin, uneven sample
  // of the rotation and undo the balance above.
  const lanes = new Map();
  [...events]
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
    .forEach((event) => {
      const lane = quarterKinds.has(templates.get(event.templateCode).kind) ? 'quarter' : 'month';
      const cursor = lanes.get(lane) ?? 0;
      lanes.set(lane, cursor + 1);
      event.assessor = assessorRotation[cursor % assessorRotation.length];
    });

  // A dormant assessor must have graded nothing recently, or the status is a label with no data
  // behind it. Their events are moved wholesale into the older half of the window.
  const cutoff = months[Math.max(0, months.length - 13)];
  for (const event of events) {
    if (!event.assessor.trait.dormant || event.month < cutoff) continue;
    event.month = months[Math.floor(months.length * 0.25)];
  }

  // Group into sessions. The grouping key is what makes two subjects share one event.
  const plans = [];
  const groups = new Map();
  for (const event of events) {
    const template = templates.get(event.templateCode);
    // Capacity reads the POLICY properties of the kind, never a family name. This compared
    // template_kind against 'ground' and 'simulator' until it was fixed: two values of the
    // db_kind mapping that migration 0032 removed and policy.yaml v1.1 deleted. No kind has
    // equalled either string since, so every session carried exactly one subject and the
    // fan-out path this file documents was never once exercised.
    const capacity = template.fan_out_on_signature ? volume.subjects_per_ground_session
      : template.facility_kind === 'ffs' ? volume.subjects_per_simulator_session : 1;
    const key = capacity > 1 && event.source === 'app'
      ? `${event.month}|${event.templateCode}|${event.assessor.external_id}`
      : `solo|${plans.length}|${event.subject.external_id}|${event.month}|${event.templateCode}`;
    if (!groups.has(key)) groups.set(key, []);
    const bucket = groups.get(key);
    const open = bucket[bucket.length - 1];
    if (open && open.subjects.length < capacity && open.source === event.source) {
      open.subjects.push(event);
      continue;
    }
    const plan = {
      month: event.month, template, assessor: event.assessor, source: event.source,
      subjects: [event],
    };
    bucket.push(plan);
    plans.push(plan);
  }

  const dayRng = rng.fork('days');
  for (const plan of plans) {
    const monthDate = new Date(`${plan.month}T00:00:00Z`);
    const lastDay = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)).getUTCDate();
    monthDate.setUTCDate(dayRng.int(1, lastDay));
    plan.date = monthDate.toISOString().slice(0, 10);
    plan.offset = quarterKinds.has(plan.template.kind)
      ? (quarterSchedule.get(plan.month)?.offset ?? 0)
      : (schedule.get(plan.month) ?? 0);
  }
  plans.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return plans;
}

/* ------------------------------------------------------------------------- *
 * Writing
 * ------------------------------------------------------------------------- */

function buildSnapshot({ plan, subject, graded, framework, configVersion, outcome }) {
  return {
    // ARRAYS OF OBJECTS, never keyed maps. A map crashes every consumer that filters, and it
    // breaks the radar, which reads spokes from the row count rather than from nine fixed keys.
    tasks: graded.elements.map((e) => ({
      element_key: e.element_key,
      task_name: e.task_name,
      external_ref: e.external_ref,
      attempt: e.attempt,
      grade: e.grade,
      remark: e.remark,
    })),
    competency_scores: graded.competencies
      .filter((c) => /^[1-5]$/.test(c.grade))       // NR / NO / NA removed, never imputed
      .map((c) => ({ code: c.code, name: framework.nameByCode.get(c.code), score: Number(c.grade) })),
    competency_remarks: graded.competencies.map((c) => ({ code: c.code, remark: c.remark })),
    template: { code: plan.template.code, name: plan.template.name, version: plan.template.version },
    framework: { code: framework.code },
    subject: {
      external_id: subject.external_id, full_name: subject.full_name, position: subject.position,
    },
    assessor: { external_id: plan.assessor.external_id, full_name: plan.assessor.full_name },
    outcome,
    config_version: configVersion,
    generated_by: 'scripts/seed-synthetic.mjs',
  };
}

export async function writePlans(client, plans, ctx) {
  const { framework, cfg, rng, population } = ctx;
  const counts = {
    sessions: 0, sessionsOpen: 0, sessionsVoid: 0, subjects: 0, elementGrades: 0, repeats: 0,
    nonScoring: 0, competencyGrades: 0, obSelections: 0, records: 0, recordsApp: 0,
    recordsImport: 0, recordTasks: 0, recordCompetencies: 0, sectors: 0,
  };
  const stateRng = rng.fork('state');
  const produced = [];

  for (const plan of plans) {
    const template = plan.template;
    const isImport = plan.source === 'import';
    const signAt = plan.assessor.trait.captureSignature === false ? null : `${plan.date}T18:00:00Z`;

    let sessionId = null;
    // A small share of sessions are left open or voided. An install where every session is
    // finalised never renders the grading surface, which is the surface an assessor lives in.
    const status = isImport ? null
      : stateRng.chance(0.04) ? 'in_progress'
      : stateRng.chance(0.01) ? 'void' : 'finalized';

    if (!isImport) {
      const { rows } = await client.query(
        `INSERT INTO sessions (template_version_id, framework_id, org_unit_id, asset_class_id,
                               session_date, facility, facility_kind, assessor_person_id, status,
                               outcome, computed_outcome, remarks, setup, assessor_signed_at,
                               assessor_signer_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,$10,$11,$12,$13,$13)
         RETURNING id`,
        [
          template.version_id, framework.id,
          ctx.orgIdByCode.get(plan.subjects[0].subject.org_code),
          template.kind === 'line_check' ? null : ctx.assetIdByCode.get(plan.subjects[0].subject.asset_code),
          plan.date, template.facility_label, template.facility_kind, plan.assessor.id,
          status === 'void' ? 'void' : status,
          status === 'finalized' ? 'Session conducted and debriefed against the published template.' : null,
          JSON.stringify({ seeded: true, difficulty_offset: plan.offset }),
          status === 'finalized' ? signAt : null,
          plan.assessor.user_id ?? null,
        ],
      );
      sessionId = rows[0].id;
      counts.sessions += 1;
      if (status === 'in_progress') counts.sessionsOpen += 1;
      if (status === 'void') counts.sessionsVoid += 1;
    }

    for (const event of plan.subjects) {
      const subject = event.subject;
      const graded = gradeSubject({
        rng: rng.fork(`grade/${subject.external_id}/${plan.date}/${template.code}`),
        template, subject, assessor: plan.assessor, offset: plan.offset,
        index: event.index, total: event.total, cfg,
      });
      const { outcome, computed } = decideOutcome(
        rng.fork(`outcome/${subject.external_id}/${plan.date}`), graded, cfg,
      );
      counts.subjects += 1;

      if (!isImport) {
        await client.query(
          `INSERT INTO session_subjects (session_id, person_id, seat_role, is_assessed, outcome,
                                         subject_signed_at)
           VALUES ($1,$2,$3,true,$4,$5) ON CONFLICT (session_id, person_id) DO NOTHING`,
          [sessionId, subject.id, cfg.seatRoles[counts.subjects % cfg.seatRoles.length],
           status === 'finalized' ? outcome : null,
           status === 'finalized' ? signAt : null],
        );
        for (const row of graded.elements) {
          await client.query(
            // The conflict target is named in full and includes instance_no (migration 0034).
            // instance_no is 1 here because no seeded template uses a repeatable group for a graded
            // element; naming it anyway is what stops this upsert falling back to the primary key
            // and raising 23505 on a legitimate re-write.
            `INSERT INTO element_grades (session_id, person_id, element_key, instance_no, attempt,
                                         grade, remark, graded_at, graded_by)
             VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)
             ON CONFLICT (session_id, person_id, element_key, instance_no, attempt) DO NOTHING`,
            [sessionId, subject.id, row.element_key, row.attempt, row.grade, row.remark,
             `${plan.date}T12:00:00Z`, plan.assessor.user_id ?? null],
          );
          counts.elementGrades += 1;
          if (row.attempt > 1) counts.repeats += 1;
          if (NON_SCORING.includes(row.grade)) counts.nonScoring += 1;
        }
        for (const competency of graded.competencies) {
          const { rows } = await client.query(
            `INSERT INTO competency_grades (session_id, person_id, framework_id, competency_id,
                                            grade, remark, graded_at, graded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (session_id, person_id, competency_id) DO NOTHING
             RETURNING id`,
            [sessionId, subject.id, framework.id, competency.competency_id, competency.grade,
             competency.remark, `${plan.date}T12:00:00Z`, plan.assessor.user_id ?? null],
          );
          counts.competencyGrades += 1;
          const gradeId = rows[0]?.id;
          if (!gradeId) continue;
          for (const obId of competency.observable_behaviour_ids) {
            await client.query(
              `INSERT INTO competency_grade_obs (competency_grade_id, observable_behaviour_id)
               VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [gradeId, obId],
            );
            counts.obSelections += 1;
          }
        }
        if (status !== 'finalized') { produced.push({ plan, subject, graded, outcome, frozen: false }); continue; }
      }

      // --- the frozen record, identical in shape for both source paths ----
      const snapshot = buildSnapshot({
        plan, subject, graded, framework, configVersion: cfg.configVersion, outcome,
      });
      const externalRef = isImport
        ? `IMPORT-${template.code}-${plan.date}-${subject.external_id}`
        : null;
      const { rows: recRows } = await client.query(
        `INSERT INTO records (session_id, person_id, source, record_kind, title, template_version_id,
                              framework_id, org_unit_id, asset_class_id, training_date,
                              assessor_person_id, assessor_label, outcome, remarks, snapshot,
                              external_ref, ingested_at, is_hidden_from_subject)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          sessionId, subject.id, isImport ? 'import' : 'app', template.record_kind,
          `${template.name} - ${plan.date} - ${subject.external_id}`,
          template.version_id, framework.id,
          ctx.orgIdByCode.get(subject.org_code),
          template.kind === 'line_check' ? null : ctx.assetIdByCode.get(subject.asset_code),
          plan.date,
          isImport ? null : plan.assessor.id,
          isImport ? `${plan.assessor.full_name} (${plan.assessor.external_id})` : null,
          outcome, null, JSON.stringify(snapshot), externalRef,
          isImport ? `${plan.date}T22:00:00Z` : null,
          template.hide_record_from_subject === true,
        ],
      );
      const recordId = recRows[0]?.id;
      if (!recordId) continue;
      counts.records += 1;
      if (isImport) counts.recordsImport += 1; else counts.recordsApp += 1;

      for (const row of graded.elements) {
        await client.query(
          // Same shape and same conflict target as element_grades above, less the session keys:
          // a frozen copy that cannot represent what the session held loses rows at finalise.
          `INSERT INTO record_tasks (record_id, element_key, external_ref, task_name, position,
                                     instance_no, attempt, grade, remark)
           VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)
           ON CONFLICT (record_id, element_key, instance_no, attempt) DO NOTHING`,
          [recordId, row.element_key, row.external_ref, row.task_name, row.position, row.attempt,
           row.grade, row.remark],
        );
        counts.recordTasks += 1;
      }
      for (const competency of graded.competencies) {
        await client.query(
          `INSERT INTO record_competencies (record_id, framework_id, competency_id, grade, remark,
                                            observable_behaviour_ids)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (record_id, competency_id) DO NOTHING`,
          [recordId, framework.id, competency.competency_id, competency.grade, competency.remark,
           competency.observable_behaviour_ids],
        );
        counts.recordCompetencies += 1;
      }

      // Same root cause as the capacity line above: this read `kind === 'line'`, a db_kind value
      // that no longer exists, so a fresh install finalised supervised-line records and wrote
      // zero sectors. The gate is the policy property docs/05 section 7 states the rule with.
      if (template.one_record_per_sector) {
        // ONE RECORD IS ONE SECTOR. Exactly one row, written with a conflict-update rather than
        // reconciling a list of legs.
        await client.query(
          `INSERT INTO line_sectors (session_id, record_id, person_id, sector_number, flight_ref,
                                     sector_date, departure, arrival, pf_role, is_supervised,
                                     outcome, remark)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,NULL)
           ON CONFLICT (session_id, person_id, sector_number) DO NOTHING`,
          [sessionId, recordId, subject.id, event.index + 1,
           `DEMO${String(100 + (event.index % 800))}`, plan.date,
           `DEMO-AD-${String.fromCharCode(65 + (event.index % 6))}`,
           `DEMO-AD-${String.fromCharCode(71 + (event.index % 6))}`,
           event.index % 2 === 0 ? 'A' : 'B', outcome],
        );
        counts.sectors += 1;
      }

      produced.push({ plan, subject, graded, outcome, computed, frozen: true, recordId });
    }

    if (!isImport && status === 'finalized') {
      await client.query(
        `UPDATE sessions SET status = 'finalized', computed_outcome = $2 WHERE id = $1`,
        [sessionId, 'PASS'],
      );
    }
  }

  void population;
  return { counts, produced };
}
