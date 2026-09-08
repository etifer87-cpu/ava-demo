/**
 * coverage.mjs - the band-coverage assertion.
 *
 * THE RULE THIS FILE ENFORCES: a band that never occurs in the seeded population has never been
 * seen to work. Every threshold in scaffold/config/analytics.yaml divides the world into named
 * regions, and half of those regions are the alert half - the half a demonstration population
 * never reaches by accident, and therefore the half that ships broken. So the generator asserts
 * that each region was actually produced, and FAILS THE RUN when one was not.
 *
 * The inverse trap is just as expensive and is the reason this file computes bands from the
 * generated data rather than trusting the profiles that were asked for: a check asserted over a
 * population the generator never produces can never fire. An assertion that always passes is
 * indistinguishable from no assertion at all.
 *
 * Every boundary below is READ FROM CONFIG. Nothing here restates a threshold.
 */

const num = (g) => (/^[1-5]$/.test(String(g ?? '').trim()) ? Number(g) : null);

function sampleSd(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const ss = values.reduce((a, b) => a + (b - mean) ** 2, 0);
  return Math.sqrt(ss / (values.length - 1));
}

const monthOf = (iso) => `${iso.slice(0, 7)}-01`;
const quarterOf = (iso) => {
  const m = Number(iso.slice(5, 7));
  return `${iso.slice(0, 4)}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
};

/* ------------------------------------------------------------------------- *
 * Screening index, computed exactly as docs/06 section 7 specifies it.
 * ------------------------------------------------------------------------- */
function screeningBands(produced, cfg) {
  const series = new Map();   // subject|competency -> [{date, grade}]
  for (const item of produced) {
    if (!item.frozen) continue;
    for (const competency of item.graded.competencies) {
      const key = `${item.subject.external_id}|${item.competency ?? competency.code}`;
      if (!series.has(key)) series.set(key, []);
      series.get(key).push({ date: item.plan.date, grade: competency.grade });
    }
  }
  const bands = new Map();
  for (const [key, rows] of series) {
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    const valid = rows.map((r) => num(r.grade)).filter((n) => n !== null);
    const window = valid.slice(-cfg.sci.window);
    let band;
    if (window.length < cfg.sci.minValid) {
      band = 'INSUFFICIENT';
    } else {
      // An unrecovered critical grade outranks the score. The clean run must be consecutive and
      // every event in it at or above the configured minimum; a grade 2 restarts it at zero.
      let critical = false;
      let run = 0;
      for (const grade of window) {
        if (grade === cfg.criticalGrade) { critical = true; run = 0; continue; }
        if (!critical) continue;
        if (grade >= cfg.sci.cleanRunMinGrade) { run += 1; if (run >= cfg.sci.cleanRunN) critical = false; }
        else run = 0;
      }
      const reversed = [...window].reverse();
      let weightSum = 0;
      let pointSum = 0;
      reversed.forEach((grade, i) => {
        if (grade === cfg.criticalGrade) return;         // never enters the arithmetic
        const w = 0.5 ** (i / cfg.sci.halfLife);
        weightSum += w;
        pointSum += w * (cfg.sci.points[String(grade)] ?? 0);
      });
      const score = weightSum > 0 ? pointSum / weightSum : 0;
      band = critical ? 'RED'
        : score < cfg.sci.amberBelow ? 'AMBER'
        : score > cfg.sci.aboveOver ? 'ABOVE' : 'STANDARD';
    }
    bands.set(key, band);
  }
  return bands;
}

/* ------------------------------------------------------------------------- *
 * Program-level indicator, per configured scope.
 * ------------------------------------------------------------------------- */
function indicatorBands(produced, cfg) {
  const out = {};
  for (const [scopeName, scope] of Object.entries(cfg.scopes)) {
    const kinds = new Set(scope.template_kinds ?? []);
    const periodOf = scope.period === 'quarter' ? quarterOf : monthOf;
    const periods = new Map();
    for (const item of produced) {
      if (!item.frozen) continue;
      if (!kinds.has(item.plan.template.kind)) continue;
      const key = periodOf(item.plan.date);
      if (!periods.has(key)) periods.set(key, { n: 0, below: 0 });
      const bucket = periods.get(key);
      for (const row of item.graded.elements) {
        const value = num(row.grade);
        if (value === null) continue;
        bucket.n += 1;
        if (value <= cfg.belowStandardMax) bucket.below += 1;
      }
    }
    const ordered = [...periods.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const baseRows = ordered.filter(([key]) => key >= scope.base_from && key <= scope.base_to);
    const basePooledN = baseRows.reduce((a, [, v]) => a + v.n, 0);
    const basePooledBelow = baseRows.reduce((a, [, v]) => a + v.below, 0);
    // POOLED, never the mean of the per-period rates.
    const baseRate = basePooledN > 0 ? basePooledBelow / basePooledN : 0;
    const sdP = sampleSd(baseRows.filter(([, v]) => v.n >= cfg.minNRate).map(([, v]) => v.below / v.n));
    const target = cfg.targetType === 'relative' ? baseRate * (1 - cfg.targetValue) : cfg.targetValue;
    const alerts = cfg.alertSigma.map((k) => baseRate + k * sdP);

    const marks = ordered.map(([key, v]) => {
      if (v.n < cfg.minNRate) return { key, state: 'suppressed', rate: null, n: v.n };
      const rate = v.below / v.n;
      let level = 0;
      alerts.forEach((limit, i) => { if (rate >= limit) level = i + 1; });
      return { key, n: v.n, rate, state: rate > target ? 'above_target' : 'at_or_below_target', alert: level };
    });

    let aboveRun = 0;
    let alertRun = 0;
    let maxAboveRun = 0;
    let maxAlertRun = 0;
    for (const mark of marks) {
      if (mark.state === 'suppressed') { aboveRun = 0; alertRun = 0; continue; }  // breaks a run
      if (mark.state === 'above_target') aboveRun += 1; else aboveRun = 0;
      if (mark.alert >= 1) alertRun += 1; else alertRun = 0;
      maxAboveRun = Math.max(maxAboveRun, aboveRun);
      maxAlertRun = Math.max(maxAlertRun, alertRun);
    }

    out[scopeName] = {
      periods: marks, baseRate, sdP, target, alerts,
      basePeriods: baseRows.length,
      maxAboveRun, maxAlertRun,
      suppressed: marks.filter((m) => m.state === 'suppressed').length,
      belowTarget: marks.filter((m) => m.state === 'at_or_below_target').length,
      alert2: marks.filter((m) => (m.alert ?? 0) >= 2).length,
      alert3: marks.filter((m) => (m.alert ?? 0) >= 3).length,
    };
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * The assertion itself
 * ------------------------------------------------------------------------- */
export function assessCoverage({ produced, population, cfg }) {
  const rows = [];
  const add = (metric, band, ok, detail, required = true) =>
    rows.push({ metric, band, ok: Boolean(ok), detail: String(detail), required });

  const frozen = produced.filter((p) => p.frozen);
  const elementGrades = frozen.flatMap((p) => p.graded.elements);
  const competencyGrades = frozen.flatMap((p) => p.graded.competencies);

  // --- grade vocabulary --------------------------------------------------
  for (const value of ['1', '2', '3', '4', '5']) {
    const n = elementGrades.filter((g) => g.grade === value).length
      + competencyGrades.filter((g) => g.grade === value).length;
    add('grade_scale', `grade ${value}`, n > 0, `${n} grades`);
  }
  for (const code of cfg.nonScoring) {
    const n = elementGrades.filter((g) => g.grade === code).length
      + competencyGrades.filter((g) => g.grade === code).length;
    add('grade_scale', `non-scoring ${code}`, n > 0, `${n} rows`);
  }
  for (const value of cfg.booleanValues) {
    const n = elementGrades.filter((g) => g.grade === value).length;
    add('grade_scale', `boolean ${value}`, n > 0, `${n} rows`);
  }

  // --- attempts ----------------------------------------------------------
  const repeats = elementGrades.filter((g) => g.attempt > 1).length;
  const subjectsWithRepeats = new Set(
    frozen.filter((p) => p.graded.elements.some((g) => g.attempt > 1)).map((p) => p.subject.external_id),
  ).size;
  add('attempts', 'attempt > 1 exists', repeats > 0, `${repeats} repeat rows`);
  add('attempts', 'repeats are a minority of subjects', subjectsWithRepeats > 0
    && subjectsWithRepeats < population.subjects.length * 0.6,
    `${subjectsWithRepeats}/${population.subjects.length} subjects`);

  // --- both source homes -------------------------------------------------
  const app = frozen.filter((p) => p.plan.source === 'app').length;
  const imported = frozen.filter((p) => p.plan.source === 'import').length;
  add('records.source', 'app', app > 0, `${app} records`);
  add('records.source', 'import', imported > 0, `${imported} records`);

  // --- concern -----------------------------------------------------------
  const bySubject = new Map();
  for (const item of frozen) {
    if (!bySubject.has(item.subject.external_id)) bySubject.set(item.subject.external_id, []);
    bySubject.get(item.subject.external_id).push(item);
  }
  let high = 0; let medium = 0; let low = 0;
  for (const [, items] of bySubject) {
    const grades = items.flatMap((i) => [...i.graded.elements, ...i.graded.competencies])
      .map((g) => num(g.grade)).filter((n) => n !== null);
    const ones = grades.filter((g) => g === cfg.criticalGrade).length;
    const twos = grades.filter((g) => g === 2).length;
    if (ones >= cfg.concern.highGrade1AtLeast) high += 1;
    else if (twos >= cfg.concern.mediumGrade2AtLeast) medium += 1;
    else if (grades.length >= cfg.concern.lowMinObservations) low += 1;
  }
  const noData = population.subjects.length - bySubject.size;
  add('concern', 'high', high > 0, `${high} subjects`);
  add('concern', 'medium', medium > 0, `${medium} subjects`);
  add('concern', 'low', low > 0, `${low} subjects`);
  add('concern', 'null (no observations)', noData > 0, `${noData} subjects`);

  // --- flagged records ---------------------------------------------------
  let flaggedByOne = 0; let flaggedByTwos = 0;
  for (const item of frozen) {
    const grades = item.graded.elements.map((g) => num(g.grade)).filter((n) => n !== null);
    const ones = grades.filter((g) => g === cfg.criticalGrade).length;
    const twos = grades.filter((g) => g === 2).length;
    if (ones >= cfg.flagged.grade1AtLeast) flaggedByOne += 1;
    else if (twos >= cfg.flagged.grade2AtLeast) flaggedByTwos += 1;
  }
  add('flagged_record', 'grade_1_at_least', flaggedByOne > 0, `${flaggedByOne} records`);
  add('flagged_record', 'grade_2_at_least', flaggedByTwos > 0, `${flaggedByTwos} records`);

  // --- screening index ---------------------------------------------------
  const sci = screeningBands(frozen, cfg);
  const tally = {};
  for (const band of sci.values()) tally[band] = (tally[band] ?? 0) + 1;
  for (const band of ['RED', 'AMBER', 'STANDARD', 'ABOVE', 'INSUFFICIENT']) {
    add('screening_index', band, (tally[band] ?? 0) > 0, `${tally[band] ?? 0} subject-competency series`);
  }

  // --- trend -------------------------------------------------------------
  let rising = 0; let falling = 0; let flat = 0; let omitted = 0;
  for (const [, items] of bySubject) {
    const points = items
      .map((i) => ({ date: i.plan.date, value: i.graded.competencies.map((c) => num(c.grade))
        .filter((n) => n !== null) }))
      .filter((p) => p.value.length > 0)
      .map((p) => ({ date: p.date, mean: p.value.reduce((a, b) => a + b, 0) / p.value.length }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (points.length < cfg.trend.minPoints) { omitted += 1; continue; }
    const half = Math.floor(points.length / 2);
    const older = points.slice(0, half).reduce((a, b) => a + b.mean, 0) / half;
    const newer = points.slice(-half).reduce((a, b) => a + b.mean, 0) / half;
    const delta = newer - older;
    if (Math.abs(delta) <= cfg.trend.flatBand) flat += 1;
    else if (delta > 0) rising += 1;
    else falling += 1;
  }
  add('trend', 'rising', rising > 0, `${rising} subjects`);
  add('trend', 'falling', falling > 0, `${falling} subjects`);
  add('trend', 'flat', flat > 0, `${flat} subjects`);
  add('trend', 'omitted (below min_points)', omitted > 0, `${omitted} subjects`);

  // --- program indicator, per scope --------------------------------------
  const indicator = indicatorBands(frozen, cfg);
  for (const [scope, result] of Object.entries(indicator)) {
    const periods = result.periods.length;
    add(`indicator.${scope}`, 'has periods', periods > 0, `${periods} periods, base rate ${result.baseRate.toFixed(4)}`);
    add(`indicator.${scope}`, 'base window populated', result.basePeriods > 0,
      `${result.basePeriods} base periods, sd_p ${result.sdP.toFixed(4)}`);
    add(`indicator.${scope}`, 'at or below target', result.belowTarget > 0, `${result.belowTarget} periods`);
    add(`indicator.${scope}`, `above target run >= ${cfg.statusRules.consecutiveAboveTarget} (AMBER)`,
      result.maxAboveRun >= cfg.statusRules.consecutiveAboveTarget, `longest run ${result.maxAboveRun}`);
    add(`indicator.${scope}`, `alert-1 run >= ${cfg.statusRules.consecutiveAtAlert1} (RED)`,
      result.maxAlertRun >= cfg.statusRules.consecutiveAtAlert1, `longest run ${result.maxAlertRun}`);
    add(`indicator.${scope}`, 'alert 2 reached', result.alert2 > 0, `${result.alert2} periods`, false);
    add(`indicator.${scope}`, 'alert 3 reached', result.alert3 > 0, `${result.alert3} periods`, false);
    add(`indicator.${scope}`, 'suppressed period (n < min_n_rate)', result.suppressed > 0,
      `${result.suppressed} periods`);
  }

  // --- cohort comparison -------------------------------------------------
  const byAsset = new Map();
  for (const subject of population.subjects) {
    byAsset.set(subject.asset_code, (byAsset.get(subject.asset_code) ?? 0) + 1);
  }
  const smallSide = [...byAsset.values()].some((n) => n < cfg.minNComparisonSide);
  const largeSide = [...byAsset.values()].some((n) => n >= cfg.minNComparisonSide);
  add('comparison', 'side below min_n_per_side (insufficient)', smallSide,
    [...byAsset.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
  add('comparison', 'side at or above min_n_per_side', largeSide, `${byAsset.size} asset classes`);

  // --- assessor fairness -------------------------------------------------
  const byAssessor = new Map();
  for (const item of frozen) {
    const key = item.plan.assessor.external_id;
    if (!byAssessor.has(key)) byAssessor.set(key, { assessor: item.plan.assessor, records: 0, grades: [] });
    const bucket = byAssessor.get(key);
    bucket.records += 1;
    for (const row of item.graded.elements) {
      const value = num(row.grade);
      if (value !== null) bucket.grades.push({ value, remark: row.remark });
    }
  }
  const banded = [...byAssessor.values()].filter((a) => a.records >= cfg.assessor.minRecordsBanded);
  const provisional = [...byAssessor.values()].filter((a) => a.records < cfg.assessor.minRecordsBanded);
  add('assessor', 'banded (>= min_records_banded)', banded.length > 0, `${banded.length} assessors`);
  add('assessor', 'provisional (< min_records_banded)', provisional.length > 0, `${provisional.length} assessors`);

  const overall = [...byAssessor.values()].flatMap((a) => a.grades.map((g) => g.value));
  const overallMean = overall.reduce((a, b) => a + b, 0) / Math.max(1, overall.length);
  const deltas = banded.map((a) => {
    const mean = a.grades.reduce((s, g) => s + g.value, 0) / Math.max(1, a.grades.length);
    const raw = mean - overallMean;
    return { key: a.assessor.external_id, adjusted: raw * a.records / (a.records + cfg.assessor.kShrink),
             sigma: sampleSd(a.grades.map((g) => g.value)) };
  });
  const adjusted = deltas.map((d) => d.adjusted);
  add('assessor', 'leniency delta above +outlier_abs',
    adjusted.some((d) => d > cfg.assessor.outlierAbs),
    `max ${Math.max(...adjusted).toFixed(2)}`);
  add('assessor', 'leniency delta below -outlier_abs',
    adjusted.some((d) => d < -cfg.assessor.outlierAbs),
    `min ${Math.min(...adjusted).toFixed(2)}`);
  add('assessor', 'spread below sigma_min', deltas.some((d) => d.sigma < cfg.assessor.sigmaMin),
    `min sigma ${Math.min(...deltas.map((d) => d.sigma)).toFixed(2)}`);
  add('assessor', 'spread above sigma_floor', deltas.some((d) => d.sigma > cfg.assessor.sigmaFloor),
    `max sigma ${Math.max(...deltas.map((d) => d.sigma)).toFixed(2)}`);

  const unjustified = [...byAssessor.values()].some((a) => a.grades.some(
    (g) => g.value <= cfg.assessor.justificationGradeMax
      && (g.remark ?? '').trim().split(/\s+/).filter(Boolean).length < cfg.assessor.justificationMinWords,
  ));
  add('assessor', 'unjustified low grade (remark under min_words)', unjustified, 'present');
  add('assessor', 'halo trait present',
    population.assessors.some((a) => a.trait.halo), 'one assessor grades every competency alike');
  add('assessor', 'signature timestamp not captured',
    population.assessors.some((a) => a.trait.captureSignature === false),
    'emitted null with "not captured", never zero');
  add('assessor', 'dormant assessor', population.assessors.some((a) => a.trait.dormant), 'present');
  add('assessor', 'grader with no login and no instructor role',
    population.assessors.some((a) => a.trait.hasUser === false), 'present');

  // --- coverage targets --------------------------------------------------
  // A RATIO, not a presence test. "Some record somewhere has an observable behaviour on it" is
  // true of almost any population and would pass whatever the generator did; the target in
  // analytics.yaml is a share of the graded competencies in a record, so that is what is measured.
  const ratios = frozen.map((p) => {
    const graded = p.graded.competencies.filter((c) => /^[1-5]$/.test(c.grade));
    if (graded.length === 0) return null;
    return {
      ob: graded.filter((c) => c.observable_behaviour_ids.length > 0).length / graded.length,
      remark: graded.filter((c) => (c.remark ?? '').trim() !== '').length / graded.length,
      competency: graded.length / Math.max(1, p.plan.template.competencies.length),
    };
  }).filter(Boolean);
  const above = (field, target) => ratios.filter((r) => r[field] >= target).length;
  const below = (field, target) => ratios.filter((r) => r[field] < target).length;
  add('coverage', 'ob coverage at or above target',
    above('ob', cfg.coverage.obCoverageMin) > 0, `${above('ob', cfg.coverage.obCoverageMin)} records`);
  add('coverage', 'ob coverage below target',
    below('ob', cfg.coverage.obCoverageMin) > 0, `${below('ob', cfg.coverage.obCoverageMin)} records`);
  add('coverage', 'remark coverage at or above target',
    above('remark', cfg.coverage.remarkCoverageMin) > 0,
    `${above('remark', cfg.coverage.remarkCoverageMin)} records`);
  add('coverage', 'remark coverage below target',
    below('remark', cfg.coverage.remarkCoverageMin) > 0,
    `${below('remark', cfg.coverage.remarkCoverageMin)} records`);
  add('coverage', 'competency coverage below target (sparse stays sparse)',
    below('competency', cfg.coverage.competencyCoverageMin) > 0,
    `${below('competency', cfg.coverage.competencyCoverageMin)} records`);

  return { rows, indicator, sci };
}
