/**
 * lib/analytics/screening-index.ts
 *
 * SCI - the subject-competency screening index. docs/06_ANALYTICS.md §7.
 *
 * Grain: ONE SCORE PER (subject, competency). There is deliberately no
 * subject-level rollup: averaging across competencies is exactly the
 * compensation this index exists to prevent.
 *
 * Purpose: decide WHERE TO LOOK. It never decides an outcome, and it is never
 * shown to the subject.
 *
 * Pure: rows in, result out. No clock, no database, no thresholds of its own.
 */

import type { AnalyticsConfig, GradeEvent, ScreeningBand, TrendArrow, Maybe } from './types';
import { ok, notAvailable } from './types';
import { clamp, mean } from './statistics';

export interface ScoredEvent {
  readonly recordId: string;
  readonly occurredOn: string;
  readonly gradeValue: number;
  /** The grade after the assessor-leniency adjustment, or the original when unadjusted. */
  readonly adjustedGrade: number;
  readonly wasAdjusted: boolean;
  /** 1.0, or screening_index.leniency.reduced_weight when the assessor did not qualify. */
  readonly contributionWeight: number;
  readonly recencyWeight: number;
  readonly points: number | null;   // null for the critical grade: it never scores
}

export interface ScreeningResult {
  readonly competencyId: string;
  readonly band: ScreeningBand;
  readonly score: Maybe<number>;
  /** Present only while the band is RED. */
  readonly recovery: { readonly achieved: number; readonly required: number } | null;
  /** Valid events since the most recent event at or below the below-standard boundary. */
  readonly sinceBelow: number | null;
  readonly trend: TrendArrow;
  readonly eventsInWindow: number;
  readonly anyAdjusted: boolean;
  readonly anyReducedWeight: boolean;
  /** Oldest to newest, for the grade chips. */
  readonly chips: readonly ScoredEvent[];
}

/**
 * Computes the index for one (subject, competency).
 *
 * @param events every valid grade event for that pair, in any order. They are
 *   sorted here so that a caller cannot change the answer by changing the order
 *   it happened to read rows in.
 */
export function screeningIndex(
  competencyId: string,
  events: readonly GradeEvent[],
  cfg: AnalyticsConfig,
): ScreeningResult {
  const s = cfg.screening_index;
  const chrono = [...events].sort(compareChrono);

  // ---- (a) the non-compensatory critical flag -----------------------------
  // Evaluated over the FULL history, not the window: a grade of 1 does not stop
  // mattering because eight sessions have passed, only because the subject has
  // posted a clean run since.
  const critical = cfg.grade_scale.critical_grade;
  const lastCriticalIdx = lastIndexWhere(chrono, (e) => e.gradeValue === critical);
  let recovery: { achieved: number; required: number } | null = null;
  let flagged = false;

  if (lastCriticalIdx >= 0) {
    let run = 0;
    for (let i = lastCriticalIdx + 1; i < chrono.length; i += 1) {
      const event = chrono[i];
      // A grade below clean_run_min_grade BREAKS the run and it restarts at zero.
      if (event !== undefined && event.gradeValue >= s.clean_run_min_grade) run += 1;
      else run = 0;
    }
    flagged = run < s.clean_run_n;
    if (flagged) recovery = { achieved: run, required: s.clean_run_n };
  }

  // ---- the window: the last N valid events, newest first -------------------
  const newestFirst = [...chrono].reverse();
  const window = newestFirst.slice(0, s.window_sessions);

  const scored: ScoredEvent[] = window.map((e, i) => {
    const { adjustedGrade, wasAdjusted, contributionWeight } = adjust(e, cfg);
    return {
      recordId: e.recordId,
      occurredOn: e.occurredOn,
      gradeValue: e.gradeValue,
      adjustedGrade,
      wasAdjusted,
      contributionWeight,
      // (d) recency weighting, in EVENTS not days: a subject who is assessed
      // rarely should not have their history decay to nothing.
      recencyWeight: Math.pow(0.5, i / s.recency_half_life),
      // (b) asymmetric points. The critical grade is absent from the table on
      // purpose: it drives the flag and never enters the arithmetic, because a
      // grade that can be averaged away is compensable.
      points: pointsFor(adjustedGrade, cfg),
    };
  });

  const chips = [...scored].reverse();           // oldest to newest for display
  const anyAdjusted = scored.some((e) => e.wasAdjusted);
  const anyReducedWeight = scored.some((e) => e.contributionWeight < 1);

  // ---- the score ----------------------------------------------------------
  const contributing = scored.filter((e) => e.points !== null);
  let num = 0;
  let den = 0;
  for (const e of contributing) {
    const w = e.recencyWeight * e.contributionWeight;
    num += w * (e.points as number);
    den += w;
  }

  const enoughEvidence = window.length >= s.min_valid_grades && den > 0;
  const score: Maybe<number> = enoughEvidence ? ok(num / den) : notAvailable('INSUFFICIENT');

  // ---- bands, in order ----------------------------------------------------
  // RED is evaluated BEFORE the evidence test. Insufficient evidence for a
  // SCORE is not insufficient evidence for a grade of 1 having been awarded.
  let band: ScreeningBand;
  if (flagged) band = 'RED';
  else if (!enoughEvidence) band = 'INSUFFICIENT';
  else if ((score as { value: number }).value < s.bands.amber_below) band = 'AMBER';
  else if ((score as { value: number }).value > s.bands.above_over) band = 'ABOVE';
  else band = 'STANDARD';

  return {
    competencyId,
    band,
    score,
    recovery,
    sinceBelow: sinceBelow(chrono, cfg),
    trend: trendArrow(scored, cfg),
    eventsInWindow: window.length,
    anyAdjusted,
    anyReducedWeight,
    chips,
  };
}

/**
 * Returns one result per competency in the framework, INCLUDING competencies
 * with no events at all. A competency is never dropped: a missing row renders as
 * a gap, and a gap reads as "fine".
 */
export function screeningIndexForFramework(
  competencyIds: readonly string[],
  events: readonly GradeEvent[],
  cfg: AnalyticsConfig,
): ScreeningResult[] {
  return competencyIds.map((id) =>
    screeningIndex(id, events.filter((e) => e.competencyId === id), cfg),
  );
}

// ---------------------------------------------------------------------------

/**
 * (c) The assessor-leniency adjustment.
 *
 * Only applied when the assessor is resolved AND meets the minimum sample.
 * Below that sample an assessor's mean is dominated by which subjects they
 * happened to assess, and adjusting by it injects more noise than it removes -
 * so the event is kept at reduced weight rather than adjusted or discarded.
 *
 * Round then clamp, in that order, so the adjusted value stays on the ordinal
 * scale the points table is defined over. Clamping at clamp_min (2, not 1)
 * prevents an adjustment from manufacturing a critical grade nobody awarded.
 */
function adjust(
  e: GradeEvent,
  cfg: AnalyticsConfig,
): { adjustedGrade: number; wasAdjusted: boolean; contributionWeight: number } {
  const l = cfg.screening_index.leniency;
  if (e.assessorId === null || !e.assessorQualifies || e.assessorDelta === null) {
    return { adjustedGrade: e.gradeValue, wasAdjusted: false, contributionWeight: l.reduced_weight };
  }
  const adjusted = clamp(Math.round(e.gradeValue - e.assessorDelta), l.clamp_min, l.clamp_max);
  return { adjustedGrade: adjusted, wasAdjusted: adjusted !== e.gradeValue, contributionWeight: 1 };
}

/** null means "this grade does not score" - today, only the critical grade. */
function pointsFor(grade: number, cfg: AnalyticsConfig): number | null {
  const p = cfg.screening_index.points[String(grade)];
  return p === undefined ? null : p;
}

function sinceBelow(chrono: readonly GradeEvent[], cfg: AnalyticsConfig): number | null {
  const idx = lastIndexWhere(chrono, (e) => e.gradeValue <= cfg.grade_scale.below_standard_max);
  if (idx < 0) return null;                 // never below standard: not "0"
  return chrono.length - 1 - idx;
}

/**
 * Half-split trend over the window's points. Omitted (NONE) below
 * trend.min_points: an arrow drawn from two events asserts a direction the
 * evidence does not carry, and FLAT would be the same lie in a calmer voice.
 */
function trendArrow(scored: readonly ScoredEvent[], cfg: AnalyticsConfig): TrendArrow {
  const pts = [...scored].reverse().map((e) => e.points).filter((p): p is number => p !== null);
  if (pts.length < cfg.trend.min_points) return 'NONE';
  const half = Math.floor(pts.length / 2);
  const older = mean(pts.slice(0, half));
  const newer = mean(pts.slice(pts.length - half));
  if (older === null || newer === null) return 'NONE';
  const delta = newer - older;
  if (delta > cfg.screening_index.trend_threshold) return 'UP';
  if (delta < -cfg.screening_index.trend_threshold) return 'DOWN';
  return 'FLAT';
}

function compareChrono(a: GradeEvent, b: GradeEvent): number {
  return a.occurredOn === b.occurredOn
    ? a.recordId.localeCompare(b.recordId)
    : a.occurredOn.localeCompare(b.occurredOn);
}

function lastIndexWhere<T>(xs: readonly T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i -= 1) {
    const x = xs[i];
    if (x !== undefined && pred(x)) return i;
  }
  return -1;
}
