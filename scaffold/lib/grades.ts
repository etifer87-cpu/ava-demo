/**
 * grades.ts - grade parsing and the standard predicates.
 *
 * Pure and client-safe: no database access, no filesystem, no globals. The grade-scale slice of the
 * analytics configuration is INJECTED. Nothing in this file hardcodes a threshold, a band boundary
 * or the non-scoring vocabulary - those live in `scaffold/config/analytics.yaml` under
 * `grade_scale`, are loaded into `config_versions`, and are read at runtime.
 *
 * The SQL side of the same definitions is `grade_num(text)` plus `analytics_int('grade_scale.…')`
 * in the 0100 range. The two must agree, which is why both read the same config keys rather than
 * each carrying its own copy. See docs/06_ANALYTICS.md.
 */

/** The `grade_scale` block of analytics.yaml. */
export interface GradeScaleConfig {
  /** The single definition of a valid grade, e.g. "^[1-5]$". */
  readonly valid_pattern: string;
  readonly min: number;
  readonly max: number;
  /** Codes stored alongside grades that resolve to NULL, e.g. NR, NO, NA. */
  readonly non_scoring: readonly string[];
  /** A grade is below standard when its numeric value is at most this. Stated once, here. */
  readonly below_standard_max: number;
  readonly meets_standard_min: number;
  /** Non-compensatory: removed from index arithmetic and handled as a flag. */
  readonly critical_grade: number;
  /**
   * How many below-standard grades a record may carry. `warn_at` is advisory and drives both the
   * Review warning and the outcome-mismatch alert; `refuse_pass_at` grades of exactly
   * `refuse_pass_grade` refuse a passing outcome outright. See config/analytics.yaml, which carries
   * the reasoning. Optional so a config written before 2026-09-16 still loads.
   */
  readonly outcome_standard?: {
    readonly warn_at: number;
    readonly refuse_pass_grade: number;
    readonly refuse_pass_at: number;
  };
}

export interface AnalyticsConfigSlice {
  readonly grade_scale: GradeScaleConfig;
}

export type RawGrade = string | null | undefined;

export type GradeKind = 'scored' | 'non_scoring' | 'empty' | 'unparseable';

export interface ParsedGrade {
  /** The stored text, trimmed and upper-cased for the non-scoring comparison. */
  readonly raw: string | null;
  readonly kind: GradeKind;
  /** The numeric value, or null. The direct equivalent of SQL `grade_num(text)`. */
  readonly value: number | null;
}

/** Compiles the configured pattern once per config object rather than once per grade. */
const patternCache = new WeakMap<GradeScaleConfig, RegExp>();

function validPattern(scale: GradeScaleConfig): RegExp {
  let re = patternCache.get(scale);
  if (!re) {
    re = new RegExp(scale.valid_pattern);
    patternCache.set(scale, re);
  }
  return re;
}

const nonScoringCache = new WeakMap<GradeScaleConfig, Set<string>>();

function nonScoringSet(scale: GradeScaleConfig): Set<string> {
  let set = nonScoringCache.get(scale);
  if (!set) {
    set = new Set(scale.non_scoring.map((c) => c.toUpperCase()));
    nonScoringCache.set(scale, set);
  }
  return set;
}

/**
 * Parses one stored grade.
 *
 * `unparseable` is a distinct outcome from `non_scoring` on purpose. A stored value that is neither
 * a grade nor a recognised code is a data-quality signal, and collapsing it into "not observed"
 * hides it forever. In the predecessor, tens of thousands of attempt rows carried a value that no
 * naive parser could read while the recorded grade was set; unnesting them without noticing simply
 * dropped the rows and quietly understated the failure count.
 */
export function parseGrade(raw: RawGrade, scale: GradeScaleConfig): ParsedGrade {
  if (raw === null || raw === undefined) return { raw: null, kind: 'empty', value: null };
  const text = String(raw).trim();
  if (text === '') return { raw: null, kind: 'empty', value: null };

  if (validPattern(scale).test(text)) {
    const value = Number(text);
    if (Number.isInteger(value) && value >= scale.min && value <= scale.max) {
      return { raw: text, kind: 'scored', value };
    }
  }

  if (nonScoringSet(scale).has(text.toUpperCase())) {
    return { raw: text.toUpperCase(), kind: 'non_scoring', value: null };
  }

  return { raw: text, kind: 'unparseable', value: null };
}

/**
 * The TypeScript equivalent of SQL `grade_num(text)`: a number for a valid grade, null otherwise.
 * Non-scoring codes and unparseable values are both excluded from BOTH the numerator and the
 * denominator of every metric. They are never imputed and never counted as a mid-scale grade.
 */
export function gradeNum(raw: RawGrade, scale: GradeScaleConfig): number | null {
  return parseGrade(raw, scale).value;
}

/** True only for a grade that scores. Use this before adding a value to any denominator. */
export function isScored(raw: RawGrade, scale: GradeScaleConfig): boolean {
  return parseGrade(raw, scale).kind === 'scored';
}

/** True for a recognised non-scoring code. Never mentioned in generated narrative. */
export function isNonScoring(raw: RawGrade, scale: GradeScaleConfig): boolean {
  return parseGrade(raw, scale).kind === 'non_scoring';
}

/**
 * BELOW STANDARD. The one definition the whole analytics layer rests on, read from
 * `grade_scale.below_standard_max`. Returns false for anything that does not score - an absent
 * grade is not a failure.
 */
export function isBelowStandard(raw: RawGrade, scale: GradeScaleConfig): boolean {
  const value = gradeNum(raw, scale);
  return value !== null && value <= scale.below_standard_max;
}

export function meetsStandard(raw: RawGrade, scale: GradeScaleConfig): boolean {
  const value = gradeNum(raw, scale);
  return value !== null && value >= scale.meets_standard_min;
}

/** A critical grade is non-compensatory: it is a flag, not a term in an average. */
export function isCritical(raw: RawGrade, scale: GradeScaleConfig): boolean {
  return gradeNum(raw, scale) === scale.critical_grade;
}

export interface GradeAggregate {
  /** Grades that scored, and therefore the denominator of every rate below. */
  readonly scored: number;
  readonly nonScoring: number;
  readonly unparseable: number;
  readonly empty: number;
  readonly belowStandard: number;
  readonly critical: number;
  /** Mean of the scored grades, or null when nothing scored. Never 0 for an empty set. */
  readonly mean: number | null;
}

/**
 * Aggregates a list of stored grades.
 *
 * Feed it EVERY attempt, not one row per task. A task graded 2 and then 4 reads as "meets standard"
 * if only the last attempt reaches this function, and below-standard counts roughly double once
 * every attempt is counted.
 */
export function aggregateGrades(raws: readonly RawGrade[], scale: GradeScaleConfig): GradeAggregate {
  let scored = 0;
  let nonScoring = 0;
  let unparseable = 0;
  let empty = 0;
  let belowStandard = 0;
  let critical = 0;
  let sum = 0;

  for (const raw of raws) {
    const parsed = parseGrade(raw, scale);
    switch (parsed.kind) {
      case 'scored': {
        const value = parsed.value as number;
        scored += 1;
        sum += value;
        if (value <= scale.below_standard_max) belowStandard += 1;
        if (value === scale.critical_grade) critical += 1;
        break;
      }
      case 'non_scoring':
        nonScoring += 1;
        break;
      case 'unparseable':
        unparseable += 1;
        break;
      default:
        empty += 1;
    }
  }

  return {
    scored,
    nonScoring,
    unparseable,
    empty,
    belowStandard,
    critical,
    mean: scored > 0 ? sum / scored : null,
  };
}

/** Below-standard rate as a proportion in [0,1], or null when nothing scored. */
export function belowStandardRate(agg: GradeAggregate): number | null {
  return agg.scored > 0 ? agg.belowStandard / agg.scored : null;
}
