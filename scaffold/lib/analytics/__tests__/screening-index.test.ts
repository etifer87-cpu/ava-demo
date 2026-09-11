/**
 * screening-index.test.ts
 *
 * The cases that matter. Each test names the failure it prevents, because a
 * test whose name is "works" gets deleted the first time it is inconvenient.
 *
 * All grades below are synthetic and were written to exercise a rule, not taken
 * from any record.
 *
 * Runner-agnostic: `describe` / `it` / `expect` in the shape every current
 * TypeScript test runner provides.
 */

import { screeningIndex, screeningIndexForFramework } from '../screening-index';
import { standardisationIndex, spreadDeduction, adjustedDelta } from '../assessor-fairness';
import type { AnalyticsConfig, GradeEvent } from '../types';

// --- configuration under test: the kit defaults from analytics.yaml ---------
// Declared AS AnalyticsConfig rather than cast to it. A cast would let this fixture drift from the
// interface, and a fixture that no longer matches the shape the modules read is a test that proves
// nothing. Keys are snake_case here because they are snake_case in analytics.yaml, in the
// analytics_config table and in AnalyticsConfig - one spelling, everywhere.
const cfg: AnalyticsConfig = {
  version: 'test',
  grade_scale: {
    valid_pattern: '^[1-5]$',
    min: 1,
    max: 5,
    non_scoring: ['NR', 'NO', 'NA'],
    below_standard_max: 2,
    meets_standard_min: 3,
    critical_grade: 1,
  },
  rate_display: {},
  suppression: { min_n_rate: 30, min_n_summary: 30, min_n_comparison_side: 8 },
  program_indicator: {
    alert_sigma: [1, 2, 3],
    target: { type: 'relative', value: 0.05 },
    status_rules: {
      consecutive_above_target: 3,
      consecutive_at_alert1: 2,
      suppressed_breaks_run: true,
    },
    sd_caveat_ratio: 0.5,
    overdispersion_warn_below: 1.2,
  },
  screening_index: {
    window_sessions: 8,
    min_valid_grades: 3,
    recency_half_life: 3.5,
    points: { '2': -5, '3': 0, '4': 1, '5': 2 },
    clean_run_n: 3,
    clean_run_min_grade: 3,
    leniency: { min_sessions: 30, reduced_weight: 0.5, clamp_min: 2, clamp_max: 5 },
    bands: { amber_below: -1.5, above_over: 0.5 },
    trend_threshold: 0.05,
  },
  concern: {
    high: { grade_1_count_at_least: 1 },
    medium: { grade_2_count_at_least: 2 },
    low: { min_observations: 1 },
  },
  flagged_record: { grade_1_at_least: 1, grade_2_at_least: 3 },
  assessor_fairness: {
    adjusted_delta: { k_shrink: 20, ci_z: 1.96, outlier_abs: 0.5, min_records_banded: 10 },
    spread: { sigma_floor: 0.6, sigma_min: 0.35 },
    habits: {
      halo: { min_competencies_graded: 6, scale_full: 0.5 },
      drift: { scale_full: 0.3 },
      not_observed: { scale_full: 0.35 },
    },
    standardisation_index: {
      base: 100,
      rescale_over_available_terms: true,
      terms: {
        leniency: { points: 15, scale_full: 0.5 },
        spread: { points: 20 },
        justification: { points: 25 },
        halo: { points: 15 },
        drift: { points: 15 },
        not_observed: { points: 10 },
      },
      bands: { green_min: 75, amber_min: 50 },
      caps: {
        open_masking_alert: 'amber',
        own_screening_red: 'amber',
        halo_ineligible: 'amber',
        two_or_more_caps: 'red',
      },
    },
    status: { dormant_after_days: 365 },
  },
  comparison: { min_n_per_side: 8, ci_z: 1.96 },
  trend: { flat_band: 0.05, min_points: 4, slope_interval_days: 90 },
  currency: {
    default_warning_days: 90,
    default_grace_days: 0,
    due_soon_days: 90,
    planned_excluded_from_due: true,
    compliant_statuses: ['VALID', 'WARNING', 'PLANNED'],
  },
};

const COMP = 'competency-under-test';

/**
 * One synthetic event at position `i`. A factory rather than `series([g])[0]`, because indexing an
 * array yields `GradeEvent | undefined` and a test that reaches for `[0]` is a test that can be
 * silently handed undefined.
 */
function event(grade: number, i: number, opts: Partial<GradeEvent> = {}): GradeEvent {
  return {
    recordId: `DEMO-REC-${String(i + 1).padStart(3, '0')}`,
    competencyId: COMP,
    // One month apart, rolling into the next year past twelve: a series longer than a year must
    // still sort in index order, or the window test reads events it thinks it discarded.
    occurredOn: `${2030 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-15`,
    gradeValue: grade,
    assessorId: 'DEMO-ASSESSOR-1',
    assessorDelta: 0,
    assessorQualifies: true,
    ...opts,
  };
}

/** Builds a series of events one month apart, oldest first. Assessor qualifies, delta 0. */
function series(grades: number[], opts: Partial<GradeEvent> = {}): GradeEvent[] {
  return grades.map((g, i) => event(g, i, opts));
}

describe('screening index: a grade 1 must not average away', () => {
  it('reads RED immediately after a critical grade, whatever the score would be', () => {
    // Eight strong grades and then a 1. A mean would call this excellent.
    const r = screeningIndex(COMP, series([5, 5, 5, 5, 5, 5, 5, 5, 1]), cfg);
    expect(r.band).toBe('RED');
    expect(r.recovery).toEqual({ achieved: 0, required: 3 });
  });

  it('excludes the critical grade from the score arithmetic entirely', () => {
    // If a grade of 1 carried points, adding it would move the score. It must not:
    // it drives the flag and nothing else.
    const withoutCritical = screeningIndex(COMP, series([4, 4, 4, 4]), cfg);
    const withCritical = screeningIndex(COMP, [
      ...series([4, 4, 4, 4]),
      event(1, 0, { recordId: 'DEMO-REC-900', occurredOn: '2030-05-15' }),
    ], cfg);
    expect(withCritical.score.ok && withoutCritical.score.ok).toBe(true);
    if (withCritical.score.ok && withoutCritical.score.ok) {
      expect(withCritical.score.value).toBeCloseTo(withoutCritical.score.value, 10);
    }
  });

  it('stays RED until a full clean run, and a grade 2 restarts that run', () => {
    // 1 then 3, 3 - two of the three required.
    const partial = screeningIndex(COMP, series([3, 3, 3, 1, 3, 3]), cfg);
    expect(partial.band).toBe('RED');
    expect(partial.recovery).toEqual({ achieved: 2, required: 3 });

    // 1 then 3, 3, 2, 3 - the 2 breaks the run, so only one clean event counts.
    const broken = screeningIndex(COMP, series([3, 3, 3, 1, 3, 3, 2, 3]), cfg);
    expect(broken.band).toBe('RED');
    expect(broken.recovery).toEqual({ achieved: 1, required: 3 });

    // 1 then three consecutive events at or above the clean-run minimum: cleared.
    const cleared = screeningIndex(COMP, series([3, 1, 3, 4, 3]), cfg);
    expect(cleared.band).not.toBe('RED');
    expect(cleared.recovery).toBeNull();
  });

  it('raises RED even when there is too little evidence to score', () => {
    // Insufficient evidence for a SCORE is not insufficient evidence for a
    // grade of 1 having been awarded.
    const r = screeningIndex(COMP, series([1]), cfg);
    expect(r.band).toBe('RED');
    expect(r.score.ok).toBe(false);
  });
});

describe('screening index: asymmetric points', () => {
  it('does not let one grade 4 cancel one grade 2', () => {
    const r = screeningIndex(COMP, series([2, 4, 3]), cfg);
    expect(r.score.ok).toBe(true);
    if (r.score.ok) expect(r.score.value).toBeLessThan(0);
  });

  it('bands a repeatedly below-standard series AMBER', () => {
    const r = screeningIndex(COMP, series([3, 2, 3, 2, 2]), cfg);
    expect(r.band).toBe('AMBER');
  });

  it('bands a consistently strong series ABOVE', () => {
    const r = screeningIndex(COMP, series([4, 5, 4, 5, 5]), cfg);
    expect(r.band).toBe('ABOVE');
  });
});

describe('screening index: insufficient evidence is a state, not a zero', () => {
  it('returns INSUFFICIENT below min_valid_grades', () => {
    const r = screeningIndex(COMP, series([3, 3]), cfg);
    expect(r.band).toBe('INSUFFICIENT');
    expect(r.score.ok).toBe(false);
    if (!r.score.ok) expect(r.score.reason).toBe('INSUFFICIENT');
  });

  it('returns a row for every competency in the framework, including ungraded ones', () => {
    const ids = ['c-1', 'c-2', 'c-3'];
    const events = series([3, 3, 3]).map((e) => ({ ...e, competencyId: 'c-1' }));
    const rows = screeningIndexForFramework(ids, events, cfg);
    expect(rows.map((r) => r.competencyId)).toEqual(ids);
    expect(rows.filter((r) => r.band === 'INSUFFICIENT')).toHaveLength(2);
  });
});

describe('screening index: recency weighting and the window', () => {
  it('weights the newest event most heavily', () => {
    const improving = screeningIndex(COMP, series([2, 2, 2, 4, 4, 4]), cfg);
    const declining = screeningIndex(COMP, series([4, 4, 4, 2, 2, 2]), cfg);
    expect(improving.score.ok && declining.score.ok).toBe(true);
    if (improving.score.ok && declining.score.ok) {
      expect(improving.score.value).toBeGreaterThan(declining.score.value);
    }
  });

  it('only considers the last window_sessions events', () => {
    const ancientBad = series([2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3]);
    const r = screeningIndex(COMP, ancientBad, cfg);
    expect(r.eventsInWindow).toBe(cfg.screening_index.window_sessions);
    if (r.score.ok) expect(r.score.value).toBe(0);
  });

  it('orders events itself, so the caller cannot change the answer by reordering rows', () => {
    const forwards = series([2, 3, 4, 5]);
    const shuffled = [2, 0, 3, 1]
      .map((i) => forwards[i])
      .filter((e): e is GradeEvent => e !== undefined);
    const a = screeningIndex(COMP, forwards, cfg);
    const b = screeningIndex(COMP, shuffled, cfg);
    expect(a.score).toEqual(b.score);
    expect(a.band).toBe(b.band);
  });
});

describe('screening index: assessor-leniency adjustment', () => {
  it('contributes at reduced weight, unadjusted, when the assessor is below the minimum sample', () => {
    const r = screeningIndex(
      COMP,
      series([3, 3, 3], { assessorQualifies: false, assessorDelta: 0.8 }),
      cfg,
    );
    expect(r.anyReducedWeight).toBe(true);
    expect(r.anyAdjusted).toBe(false);
    expect(r.chips.every((c) => c.adjustedGrade === c.gradeValue)).toBe(true);
  });

  it('never manufactures a critical grade from an adjustment', () => {
    // A very lenient assessor would push a 2 below the scale without the clamp.
    const r = screeningIndex(COMP, series([2, 2, 2], { assessorDelta: 3 }), cfg);
    expect(r.chips.every((c) => c.adjustedGrade >= cfg.screening_index.leniency.clamp_min)).toBe(true);
    expect(r.band).not.toBe('RED');
  });

  it('treats an unresolved assessor as reduced weight rather than dropping the event', () => {
    const r = screeningIndex(
      COMP,
      series([3, 3, 3], { assessorId: null, assessorDelta: null, assessorQualifies: false }),
      cfg,
    );
    expect(r.eventsInWindow).toBe(3);
    expect(r.score.ok).toBe(true);
  });
});

describe('assessor fairness: an all-identical grader must not score green', () => {
  it('penalises zero spread through the two-sided term', () => {
    const scaled = spreadDeduction(0, cfg);
    expect(scaled.ok).toBe(true);
    if (scaled.ok) expect(scaled.value).toBe(1);   // full deduction, not zero
  });

  it('penalises excessive spread as well', () => {
    const scaled = spreadDeduction(1.5, cfg);
    expect(scaled.ok).toBe(true);
    if (scaled.ok) expect(scaled.value).toBe(1);
  });

  it('lands an assessor who awards one grade to everything outside the green band', () => {
    // Awards nothing below standard (no justification term), never grades a full
    // set (no halo term), zero spread, no drift signal.
    const r = standardisationIndex(
      {
        delta: 0.05,
        sigma: 0,
        justificationRate: null,
        haloRate: null,
        drift: null,
        notObservedExcess: 0,
        nRecords: 40,
      },
      { halo_ineligible: true },
      cfg,
    );
    expect(r.band).not.toBe('green');
    expect(r.score).not.toBeNull();
    if (r.score !== null) expect(r.score).toBeLessThan(cfg.assessor_fairness.standardisation_index.bands.green_min);
  });
});

describe('assessor fairness: unavailable terms must not act as free credit', () => {
  it('excludes unavailable terms from the denominator', () => {
    const r = standardisationIndex(
      {
        delta: 0, sigma: 0.45, justificationRate: null, haloRate: null,
        drift: null, notObservedExcess: null, nRecords: 40,
      },
      {},
      cfg,
    );
    const si = cfg.assessor_fairness.standardisation_index;
    // Only leniency and spread could fire.
    expect(r.availablePoints).toBe(si.terms.leniency.points + si.terms.spread.points);
    expect(r.terms.filter((t) => !t.available).map((t) => t.name).sort()).toEqual(
      ['drift', 'halo', 'justification', 'not_observed'],
    );
  });

  it('scores the same evidence identically whether or not other terms exist', () => {
    // Full deduction on the only two available terms must be a very low score,
    // NOT a high one propped up by 65 un-loseable points.
    const r = standardisationIndex(
      {
        delta: 1, sigma: 0, justificationRate: null, haloRate: null,
        drift: null, notObservedExcess: null, nRecords: 40,
      },
      {},
      cfg,
    );
    expect(r.score).toBeCloseTo(0, 6);
  });

  it('does not band a provisional assessor at all', () => {
    const r = standardisationIndex(
      {
        delta: 0, sigma: 0.45, justificationRate: 1, haloRate: 0,
        drift: 0, notObservedExcess: 0, nRecords: 3,
      },
      {},
      cfg,
    );
    expect(r.band).toBe('not_banded');
    expect(r.isProvisional).toBe(true);
  });

  it('caps the band, and two caps force red', () => {
    const inputs = {
      delta: 0, sigma: 0.45, justificationRate: 1, haloRate: 0,
      drift: 0, notObservedExcess: 0, nRecords: 40,
    };
    expect(standardisationIndex(inputs, {}, cfg).band).toBe('green');
    expect(standardisationIndex(inputs, { open_masking_alert: true }, cfg).band).toBe('amber');
    expect(
      standardisationIndex(inputs, { open_masking_alert: true, own_screening_red: true }, cfg).band,
    ).toBe('red');
  });
});

describe('assessor fairness: shrinkage', () => {
  it('pulls a low-volume assessor toward zero more than a high-volume one', () => {
    const few = adjustedDelta(
      { meanResidual: 0.6, sdResidual: 0.5, nGrades: 5, nRecords: 12, unadjustedDelta: 0.6 },
      cfg,
    );
    const many = adjustedDelta(
      { meanResidual: 0.6, sdResidual: 0.5, nGrades: 500, nRecords: 60, unadjustedDelta: 0.6 },
      cfg,
    );
    expect(Math.abs(few.adjusted)).toBeLessThan(Math.abs(many.adjusted));
    expect(few.isOutlier).toBe(false);
    expect(many.isOutlier).toBe(true);
  });

  it('never flags a provisional assessor as an outlier', () => {
    const r = adjustedDelta(
      { meanResidual: 2, sdResidual: 0.5, nGrades: 400, nRecords: 4, unadjustedDelta: 2 },
      cfg,
    );
    expect(r.isProvisional).toBe(true);
    expect(r.isOutlier).toBe(false);
  });
});
