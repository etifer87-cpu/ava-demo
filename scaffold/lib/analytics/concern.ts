/**
 * lib/analytics/concern.ts
 *
 * Concern level. docs/06_ANALYTICS.md §8.
 *
 * ONE derivation, read by every surface through one endpoint. Two surfaces
 * computing the same concept from two different sources will disagree, and the
 * disagreement stays invisible until someone puts the screens side by side.
 */

import type { AnalyticsConfig, ConcernLevel } from './types';

export interface ConcernInput {
  readonly nValid: number;
  readonly nCritical: number;
  /** Grades exactly at the below-standard boundary (grade 2 by default). */
  readonly nAtBoundary: number;
  readonly override: ConcernLevel | null;
  /** A concern level produced by the narrative pipeline, if any. Ranks last. */
  readonly modelConcern?: ConcernLevel | null;
}

export interface ConcernResult {
  readonly level: ConcernLevel | null;
  readonly source: 'override' | 'derived' | 'model' | 'none';
}

/**
 * Returns null when there are no observations. Null renders "no data" - never
 * "Low". A subject with no gradable history is not a low-concern subject; they
 * are an unmeasured one, and the two must not look the same on a roster.
 */
export function deriveConcern(input: ConcernInput, cfg: AnalyticsConfig): ConcernResult {
  if (input.override !== null) return { level: input.override, source: 'override' };

  const c = cfg.concern;
  if (input.nCritical >= c.high.grade_1_count_at_least) return { level: 'HIGH', source: 'derived' };
  if (input.nAtBoundary >= c.medium.grade_2_count_at_least) return { level: 'MEDIUM', source: 'derived' };
  if (input.nValid >= c.low.min_observations) return { level: 'LOW', source: 'derived' };

  // The deterministic rule ranks first and the model ranks last, and when the
  // model supplies the value the surface labels it as model-derived.
  if (input.modelConcern) return { level: input.modelConcern, source: 'model' };
  return { level: null, source: 'none' };
}

/** A record-level advisory flag. docs/06_ANALYTICS.md §9. Never affects the record's outcome. */
export function isFlaggedRecord(
  counts: { nCritical: number; nAtBoundary: number },
  cfg: AnalyticsConfig,
): boolean {
  return (
    counts.nCritical >= cfg.flagged_record.grade_1_at_least ||
    counts.nAtBoundary >= cfg.flagged_record.grade_2_at_least
  );
}
