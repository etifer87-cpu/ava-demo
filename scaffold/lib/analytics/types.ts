/**
 * lib/analytics/types.ts
 *
 * Shared types for the deterministic analytics core.
 * Specified by docs/06_ANALYTICS.md.
 *
 * Every module in this folder is a PURE FUNCTION library:
 *   - no database access, no fetch, no I/O;
 *   - no wall clock - anything time-relative takes an injected `asOf`;
 *   - no thresholds of its own - every constant arrives in `AnalyticsConfig`,
 *     loaded from scaffold/config/analytics.yaml;
 *   - no randomness.
 * That is what makes every figure reproducible and unit-testable, and it is why
 * no number in this platform can originate in a language model.
 *
 * KEY CASING IS snake_case, DELIBERATELY, AND IT IS NOT NEGOTIABLE.
 * `AnalyticsConfig` mirrors scaffold/config/analytics.yaml KEY FOR KEY. The same keys are also the
 * dotted paths in the `analytics_config` table that every av_* view reads through
 * `analytics_int('grade_scale.below_standard_max')` and friends. Three readers - the YAML, the SQL
 * and this library - therefore name every threshold with the same string, and a key can be grepped
 * from one end of the platform to the other.
 *
 * A camelCase mirror of this interface was tried and it cost a whole afternoon: the loader flattens
 * YAML keys verbatim, so `rateDisplay` simply was not there at runtime, `cfg.rate_display[metric]`
 * type-errored against a declaration nobody had run, and the two spellings each looked correct in
 * isolation. The TypeScript convention for a local variable does not extend to a wire format that
 * arrives from a file. This object is a wire format.
 */

import type { GradeScaleConfig } from '../grades';

export type GradeText = string;          // stored form: "1".."5" | "NR" | "NO" | "NA" | ""
export type GradeValue = 1 | 2 | 3 | 4 | 5;

export type Band = 'GREEN' | 'AMBER' | 'RED' | 'SUPPRESSED';
export type ScreeningBand = 'RED' | 'AMBER' | 'STANDARD' | 'ABOVE' | 'INSUFFICIENT';
export type ConcernLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type TrendArrow = 'UP' | 'FLAT' | 'DOWN' | 'NONE';
export type CurrencyStatus =
  | 'VALID' | 'WARNING' | 'PLANNED' | 'EXPIRED' | 'MISSING' | 'SUSPENDED' | 'INACTIVE';

/** The six deductible terms of the standardisation index. Names match analytics.yaml exactly. */
export type AsiTermName =
  | 'leniency' | 'spread' | 'justification' | 'halo' | 'drift' | 'not_observed';

/**
 * The band of a standardisation index. `not_banded` is a real state, not a missing value: an
 * assessor below assessor_fairness.adjusted_delta.min_records_banded is provisional and is
 * excluded from outlier flags and from banding entirely.
 */
export type AsiBand = 'green' | 'amber' | 'red' | 'not_banded';

/** Cap names, as analytics.yaml spells them under assessor_fairness.standardisation_index.caps. */
export type AsiCapName =
  | 'open_masking_alert' | 'own_screening_red' | 'halo_ineligible' | 'two_or_more_caps';

/**
 * One entry of analytics.yaml's `rate_display`. The three fields travel together on purpose: the
 * two headline metrics have different denominators, so a unit string detached from its denominator
 * overstates one of them by roughly the number of competencies graded per record.
 */
export interface RateDisplay {
  denominator: number;
  unit: string;
  axis_label: string;
}

/**
 * The subset of analytics.yaml the pure core needs, keyed exactly as the file keys it. Injected,
 * never imported from disk by a module in this folder.
 *
 * Blocks the file carries that only SQL reads - `control_chart`, `coverage`, `program_summary`,
 * `data_quality`, and the parts of `program_indicator` and `assessor_fairness` consumed inside the
 * av_* views - are absent here on purpose. This interface describes what the TypeScript core is
 * handed, not the whole file.
 */
export interface AnalyticsConfig {
  version: string;
  /** The same block lib/grades.ts is given; one declaration, so the two cannot drift. */
  grade_scale: GradeScaleConfig;
  rate_display: Record<string, RateDisplay>;
  suppression: {
    min_n_rate: number;
    min_n_summary: number;
    min_n_comparison_side: number;
  };
  program_indicator: {
    alert_sigma: number[];
    target: { type: 'relative' | 'absolute'; value: number };
    status_rules: {
      consecutive_above_target: number;
      consecutive_at_alert1: number;
      suppressed_breaks_run: boolean;
    };
    sd_caveat_ratio: number;
    overdispersion_warn_below: number;
  };
  screening_index: {
    window_sessions: number;
    min_valid_grades: number;
    recency_half_life: number;
    /** Keyed by the grade as a string, exactly as the YAML writes it. */
    points: Record<string, number>;
    clean_run_n: number;
    clean_run_min_grade: number;
    leniency: {
      min_sessions: number;
      reduced_weight: number;
      clamp_min: number;
      clamp_max: number;
    };
    bands: { amber_below: number; above_over: number };
    trend_threshold: number;
  };
  concern: {
    high: { grade_1_count_at_least: number };
    medium: { grade_2_count_at_least: number };
    low: { min_observations: number };
  };
  flagged_record: { grade_1_at_least: number; grade_2_at_least: number };
  assessor_fairness: {
    adjusted_delta: {
      k_shrink: number;
      ci_z: number;
      outlier_abs: number;
      min_records_banded: number;
    };
    spread: { sigma_floor: number; sigma_min: number };
    habits: {
      halo: { min_competencies_graded: number; scale_full: number };
      drift: { scale_full: number };
      not_observed: { scale_full: number };
    };
    standardisation_index: {
      base: number;
      rescale_over_available_terms: boolean;
      terms: Record<AsiTermName, { points: number; scale_full?: number }>;
      bands: { green_min: number; amber_min: number };
      caps: Partial<Record<AsiCapName, 'amber' | 'red'>>;
    };
    status: { dormant_after_days: number };
  };
  comparison: { min_n_per_side: number; ci_z: number };
  trend: { flat_band: number; min_points: number; slope_interval_days: number };
  currency: {
    default_warning_days: number;
    default_grace_days: number;
    due_soon_days: number;
    planned_excluded_from_due: boolean;
    compliant_statuses: CurrencyStatus[];
  };
}

/** One valid grade event, as av_screening_input / av_trend_input emit it. */
export interface GradeEvent {
  recordId: string;
  competencyId: string;
  occurredOn: string;          // ISO date; ordering only, never parsed for "now"
  gradeValue: number;          // already coerced; NR/NO/NA never reach here
  assessorId: string | null;
  /** Mean grade of this assessor minus the all-assessor mean; null when unresolved. */
  assessorDelta: number | null;
  /** Whether that assessor meets screening_index.leniency.min_sessions. */
  assessorQualifies: boolean;
}

export interface RateRow {
  period: string;              // ISO date of the period start
  num: number;
  den: number;
}

/**
 * Result of any computation that can legitimately have no answer.
 *
 * The four reasons are distinct claims and must never be collapsed into a null: "no data" and
 * "measured, and the answer is zero" are different sentences, and a surface that renders the first
 * as the second reports a clean result for something nobody looked at.
 */
export type Maybe<T> = { ok: true; value: T } | { ok: false; reason: Insufficiency };
export type Insufficiency = 'NO_DATA' | 'INSUFFICIENT' | 'NOT_CAPTURED' | 'NOT_APPLICABLE';

export const notAvailable = (reason: Insufficiency): Maybe<never> => ({ ok: false, reason });
export const ok = <T>(value: T): Maybe<T> => ({ ok: true, value });
