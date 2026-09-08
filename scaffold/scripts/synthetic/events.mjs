/**
 * events.mjs - sessions, grades, records, sectors.
 *
 * Two rules govern every line in this file.
 *
 * ONE: the seed must write EXACTLY what the application writes. Same tables, same columns, same
 * key shapes, same attempt semantics, same snapshot structure. A seed that takes a shortcut - one
 * row per element instead of one row per attempt, a keyed map in the snapshot instead of an array
 * of objects - produces a database the tests pass against and the application never creates. The
 * tests then test a fiction.
 *
 * TWO: both source paths are populated. records.source is 'app' for a session graded here and
 * 'import' for a record that arrived from somewhere else, and BOTH live in the same table. A read
 * surface that queries one of them reports zeros for the other, silently, and that is the single
 * most expensive defect this schema was designed to prevent. If the generator only produced one
 * source, the defect could not be reproduced and therefore could not be tested for.
 */

/* ------------------------------------------------------------------------- *
 * Neutral remark text. Deliberately generic: no operator phrasing, no route,
 * no aircraft, nothing that could have come from a real record.
 * ------------------------------------------------------------------------- */
const SUBSTANTIVE_REMARKS = [
  'Deviation identified late and corrected only after a prompt from the other crew member.',
  'Standard call omitted; the sequence was completed correctly after a reminder was given.',
  'Task completed within tolerance after an initial overshoot and a prompt correction.',
  'Workload rose sharply and the checklist was interrupted twice before it was completed.',
  'Briefing omitted the principal threat for the conditions given in the scenario.',
  'Recovery was prompt but the initial control input exceeded what the situation required.',
  'Automation mode change was not announced and was detected only on the second scan.',
];
const SHORT_REMARKS = ['Needs work.', 'Below standard.', 'Discussed.', 'See debrief.'];
const REUSED_REMARK = 'Performance was discussed in the debrief and improvement points were agreed.';
const POSITIVE_REMARKS = [
  'Consistently ahead of the aircraft and the plan was communicated clearly throughout.',
  'Threats were identified early and the mitigation was briefed before it was needed.',
];

export const NON_SCORING = ['NR', 'NO', 'NA'];

/** Stable per-element difficulty, so the same element is always the hard one. */
function difficultyOf(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ((h % 1000) / 1000 - 0.5) * 0.6;
}

const clampGrade = (n) => String(Math.max(1, Math.min(5, Math.round(n))));

/* ------------------------------------------------------------------------- *
 * The period difficulty schedule.
 *
 * This is the mechanism that makes the program-indicator bands OCCUR. Every band
 * boundary is derived from the base window, so the base window is left flat and
 * every excursion is placed AFTER it: a base that contains the excursions
 * estimates its own standard deviation from them and nothing ever alerts.
 * ------------------------------------------------------------------------- */
export function buildDifficultySchedule({ months, baseTo, quietCount, scopes }) {
  const schedule = new Map();
  const quiet = new Set();
  let afterBase = 0;
  for (const month of months) {
    if (month <= baseTo) {
      schedule.set(month, 0);          // flat base window
      continue;
    }
    afterBase += 1;
    // offset is added to the underlying grade: negative offsets depress grades and raise the
    // below-standard rate, positive offsets do the opposite.
    let offset = 0;
    // EVERY EXCURSION CARRIES A MARGIN. An offset of 0 puts the period at the base rate, and the
    // target is only a relative_value fraction below the base rate, so "0 means above target" is
    // a coin flip decided by counting noise at these denominators - which is exactly how a
    // consecutive-period band comes out one period short on a clean install. A period that is
    // meant to be above target is depressed until it is unambiguously above target.
    switch (true) {
      case afterBase <= 3: offset = -0.25; break;          // above target -> first AMBER run
      case afterBase === 4: offset = 0.35; break;          // below target: resets both runs
      case afterBase === 5: offset = 0; quiet.add(month); break;   // no events: BREAKS the run
      case afterBase <= 7: offset = -0.6; break;           // at alert 1 and 2 -> RED run
      case afterBase === 8: offset = -0.9; break;          // at alert 3
      case afterBase === 9: offset = 0; if (quiet.size < quietCount) quiet.add(month); break;
      case afterBase <= 12: offset = -0.25; break;         // second above-target run
      case afterBase <= 14: offset = -0.45; break;         // deeper still: continues that run
      default: offset = 0.3;                               // recovery: below target
    }
    schedule.set(month, offset);
  }
  return {
    schedule,
    quiet,
    quarterSchedule: buildQuarterCalendar(months, baseTo),
    quarterKinds: quarterlyKinds(scopes),
  };
}

/* ------------------------------------------------------------------------- *
 * The QUARTERLY calendar, for scopes whose period is a quarter.
 *
 * A monthly calendar cannot express a quarter. Three months of alternating offsets average out
 * inside one quarter, so a quarterly scope driven by the schedule above lands wherever counting
 * noise puts it, and its consecutive-period bands then occur or fail to occur by luck. This
 * calendar is laid out in whole quarters after the base instead, and it carries a VOLUME factor
 * as well as a grade offset, because the suppression band is a statement about n and n was
 * previously left entirely to chance.
 *
 * offset: added to the underlying grade, exactly as above - negative depresses grades and raises
 *         the below-standard rate.
 * volume: multiplies the scheduling weight of the scope's templates for that quarter. Below 1 is
 *         a quarter with too little line activity to publish a rate for; above 1 is a quarter
 *         that carries enough events to be read at all at a quarterly grain.
 *
 * The base window is left flat and at volume 1, for the same reason as above: a base that
 * contains the excursions estimates its own standard deviation from them and nothing alerts.
 * ------------------------------------------------------------------------- */
const QUARTER_CALENDAR = [
  { offset: 0, volume: 0.35 },      // 1st after base: too few events - SUPPRESSED, breaks a run
  { offset: 0.5, volume: 2.2 },     // 2nd: clearly below target, resets both runs
  { offset: -0.35, volume: 2.2 },   // 3rd: above target, run 1
  { offset: -0.35, volume: 2.2 },   // 4th: above target, run 2
  { offset: -0.6, volume: 2.2 },    // 5th: above target, run 3 -> AMBER; and at alert 1
  { offset: -0.6, volume: 2.2 },    // 6th: at alert 1 again -> RED
];
const QUARTER_RECOVERY = { offset: 0.3, volume: 2.2 };   // anything beyond the calendar

const quarterStartOf = (iso) => {
  const m = Number(iso.slice(5, 7));
  return `${iso.slice(0, 4)}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
};

/** Template kinds belonging to a scope measured by quarter. Read from config, never listed here. */
function quarterlyKinds(scopes) {
  return new Set(
    Object.values(scopes ?? {})
      .filter((scope) => scope.period === 'quarter')
      .flatMap((scope) => scope.template_kinds ?? []),
  );
}

function buildQuarterCalendar(months, baseTo) {
  const baseQuarter = quarterStartOf(baseTo);
  const after = [...new Set(months.map(quarterStartOf))].filter((q) => q > baseQuarter).sort();
  const byQuarter = new Map();
  after.forEach((quarter, i) => byQuarter.set(quarter, QUARTER_CALENDAR[i] ?? QUARTER_RECOVERY));
  const out = new Map();
  for (const month of months) {
    out.set(month, byQuarter.get(quarterStartOf(month)) ?? { offset: 0, volume: 1 });
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Grade drawing
 * ------------------------------------------------------------------------- */

function drawGrade(rng, { skill, bias, sd, difficulty, offset }) {
  return clampGrade(rng.normal(skill + bias + difficulty + offset, sd));
}

function remarkFor(rng, grade, trait, cfg) {
  const numeric = /^[1-5]$/.test(grade) ? Number(grade) : null;
  if (trait.reuseRemark) return REUSED_REMARK;
  if (numeric !== null && numeric <= cfg.justificationGradeMax) {
    if (trait.shortRemarks) return rng.pick(SHORT_REMARKS);
    return rng.chance(cfg.remarkShareLowGrades) ? rng.pick(SUBSTANTIVE_REMARKS) : null;
  }
  if (numeric !== null && numeric >= 5) return rng.chance(0.4) ? rng.pick(POSITIVE_REMARKS) : null;
  return rng.chance(0.15) ? rng.pick(SUBSTANTIVE_REMARKS) : null;
}

/**
 * Grades one subject in one session against one template version.
 * Returns { elements: [...], competencies: [...] } in EXACTLY the row shapes the app writes.
 */
export function gradeSubject({ rng, template, subject, assessor, offset, index, total, cfg }) {
  const profile = subject.profile;
  const trait = assessor.trait;
  const yearsIn = total > 1 ? index / (total - 1) : 0;
  const skill = profile.mean + (profile.trendPerYear ?? 0) * yearsIn * (cfg.windowYears / 2)
    + subject.aptitude;
  const bias = (trait.bias ?? 0) + (trait.driftPerYear ?? 0) * yearsIn * (cfg.windowYears / 2);
  // Both dispersions matter and neither is the whole story: a variable subject graded by a
  // consistent assessor and a consistent subject graded by a variable assessor produce the same
  // spread in the data, and an assessor-fairness metric that reads one as the other is measuring
  // the roster. Combined in quadrature so neither disappears.
  const sd = Math.sqrt(((trait.sd ?? 0.7) ** 2 + (profile.sd ?? 0.6) ** 2) / 2);
  const notObservedShare = Math.max(cfg.nonScoringShare, trait.notObservedShare ?? 0);

  const graded = template.elements.filter((e) => e.is_graded);
  const elements = [];
  let twosPlaced = 0;

  for (const element of graded) {
    if (rng.chance(notObservedShare)) {
      elements.push({
        element_key: element.element_key, attempt: 1, grade: rng.pick(NON_SCORING),
        remark: null, task_name: element.title, external_ref: element.external_ref,
        position: element.position,
      });
      continue;
    }
    if (element.grade_type === 'boolean') {
      const value = rng.chance(0.9) ? cfg.booleanValues[0] : cfg.booleanValues[1];
      elements.push({
        element_key: element.element_key, attempt: 1, grade: value, remark: null,
        task_name: element.title, external_ref: element.external_ref, position: element.position,
      });
      continue;
    }

    // An assessor who awards one grade to everything: sigma near zero, perfect
    // non-discrimination, and a one-sided spread term would score them as well calibrated.
    let grade = trait.fixedGrade
      ? (rng.chance(trait.fixedGradeDeviation ?? 0.05)
          ? clampGrade(Number(trait.fixedGrade) + (rng.chance(0.5) ? 1 : -1))
          : trait.fixedGrade)
      : drawGrade(rng, { skill, bias, sd, difficulty: difficultyOf(element.element_key), offset });

    // The flagged-record profile needs a record carrying at least the configured number of
    // grade-2 rows and no grade 1: the two flag triggers are different keys and must not share
    // one population.
    if (profile.twosPerRecord && twosPlaced < profile.twosPerRecord && index === total - 2) {
      grade = '2';
      twosPlaced += 1;
    }

    const row = {
      element_key: element.element_key, attempt: 1, grade,
      remark: remarkFor(rng, grade, trait, cfg),
      task_name: element.title, external_ref: element.external_ref, position: element.position,
    };
    elements.push(row);

    // A REPEAT IS A ROW. The first attempt keeps its grade; the repeat is a second row on the same
    // element_key. Overwriting attempt 1 would hide the initial failure entirely, and the
    // below-standard count would read roughly half of the truth.
    // A REALISTIC MINORITY. Repeat eligibility is decided ONCE PER SUBJECT, not per element:
    // rolling it per element gives almost every subject a repeat somewhere over two years, which
    // is a population no operator would recognise.
    const canRepeat = template.supports_attempts && (element.max_attempts ?? 1) > 1
      && subject.repeatEligible === true;
    if (canRepeat && Number(grade) <= cfg.belowStandardMax && rng.chance(profile.repeatShare ?? 0.45)) {
      elements.push({
        element_key: element.element_key, attempt: 2,
        grade: clampGrade(Number(grade) + rng.int(1, 2)),
        remark: 'Repeated after the first attempt and completed to standard.',
        task_name: element.title, external_ref: element.external_ref, position: element.position,
      });
    }
  }

  // --- competency grades -------------------------------------------------
  const pool = profile.maxCompetencies
    ? template.competencies.slice(0, profile.maxCompetencies)
    : template.competencies;
  const competencies = [];
  const haloGrade = trait.halo ? drawGrade(rng, { skill, bias, sd, difficulty: 0, offset }) : null;

  for (const competency of pool) {
    // A sparse source stays sparse: not every session grades every competency.
    if (!trait.halo && rng.chance(0.06)) continue;
    let grade = haloGrade ?? (trait.fixedGrade
      ? trait.fixedGrade
      : drawGrade(rng, { skill, bias, sd, difficulty: 0, offset }));
    if (rng.chance(cfg.nonScoringShare * 0.5)) grade = rng.pick(NON_SCORING);
    competencies.push({
      code: competency.code,
      competency_id: competency.id,
      grade,
      remark: remarkFor(rng, grade, trait, cfg),
      observable_behaviour_ids: rng.chance(cfg.obSelectionShare)
        ? rng.sample(competency.ob_ids, rng.int(1, Math.min(3, competency.ob_ids.length)))
        : [],
    });
  }

  // Forced grades: the profiles whose whole purpose is a specific band. Applied to BOTH a
  // competency grade and an element grade, because the concern and screening surfaces do not read
  // the same layer and a band that only exists in one of them is only half exercised.
  for (const force of profile.forced ?? []) {
    if (index !== total - 1 - force.fromEnd) continue;
    if (competencies.length > 0) {
      competencies[0].grade = force.grade;
      competencies[0].remark = force.grade === '1'
        ? 'An unsafe situation developed and the recovery required intervention by the assessor.'
        : competencies[0].remark;
    }
    const scored = elements.filter((e) => /^[1-5]$/.test(e.grade));
    if (scored.length > 0) scored[0].grade = force.grade;
  }

  return { elements, competencies };
}

/* ------------------------------------------------------------------------- *
 * Outcome. EXPLICIT, never inferred. The generator decides it the way an
 * assessor does - by judgement - and stores the deterministic core's suggestion
 * beside it so the two can disagree, which they must be able to do.
 * ------------------------------------------------------------------------- */
export function decideOutcome(rng, graded, cfg) {
  const numeric = graded.elements
    .map((e) => (/^[1-5]$/.test(e.grade) ? Number(e.grade) : null))
    .filter((n) => n !== null);
  const competencyNumeric = graded.competencies
    .map((c) => (/^[1-5]$/.test(c.grade) ? Number(c.grade) : null))
    .filter((n) => n !== null);
  const hasCritical = [...numeric, ...competencyNumeric].some((n) => n === cfg.criticalGrade);
  const belowCount = [...numeric, ...competencyNumeric].filter((n) => n <= cfg.belowStandardMax).length;

  const computed = hasCritical ? 'FAIL' : belowCount > 4 ? 'PARTIAL PASS' : 'PASS';
  let outcome = computed;
  // A record can carry a below-standard grade and still pass. Roughly one in six disagreements
  // exists on purpose so that outcome_is_overridden and the disagreement surface have data.
  if (computed === 'PARTIAL PASS' && rng.chance(0.5)) outcome = 'PASS';
  else if (computed === 'PASS' && rng.chance(0.03)) outcome = 'INCOMPLETE';
  else if (computed === 'FAIL' && rng.chance(0.25)) outcome = 'PARTIAL PASS';
  return { outcome, computed };
}
