/**
 * lib/analytics/assessor-fairness.ts
 *
 * Assessor grading-fairness measures. docs/06_ANALYTICS.md §13.
 *
 * These are management instruments for a standardisation conversation. An
 * assessor never sees their own page: a self-view lets someone watch their own
 * alert queue and infer which records are under review before that conversation
 * happens.
 *
 * Pure. Every threshold is injected. Nothing here reads a clock except through
 * the `asOf` argument on status().
 */

import type { AnalyticsConfig, AsiBand, AsiTermName, Maybe } from './types';
import { ok, notAvailable } from './types';
import { clamp } from './statistics';

// ---------------------------------------------------------------------------
// Adjusted leniency delta
// ---------------------------------------------------------------------------

export interface DeltaInput {
  /** Mean of (grade - expected grade from OTHER assessors on the SAME subjects). */
  readonly meanResidual: number;
  readonly sdResidual: number | null;
  readonly nGrades: number;
  readonly nRecords: number;
  /** Own mean minus the peer mean. Kept for display, never used for banding. */
  readonly unadjustedDelta: number;
}

export interface DeltaResult {
  readonly adjusted: number;
  readonly unadjusted: number;
  readonly ciHalfWidth: number | null;
  readonly isProvisional: boolean;
  readonly isOutlier: boolean;
}

/**
 * Shrinks the mean residual toward zero by n / (n + k).
 *
 * Shrinkage is mandatory. Without it the assessors with the fewest events
 * occupy both ends of the ranking every time, purely as an artefact of
 * variance, and every review cycle is spent on noise.
 */
export function adjustedDelta(input: DeltaInput, cfg: AnalyticsConfig): DeltaResult {
  const d = cfg.assessor_fairness.adjusted_delta;
  const adjusted = (input.meanResidual * input.nGrades) / (input.nGrades + d.k_shrink);
  const isProvisional = input.nRecords < d.min_records_banded;
  return {
    adjusted,
    unadjusted: input.unadjustedDelta,
    ciHalfWidth:
      input.sdResidual === null || input.nGrades < 2
        ? null
        : (d.ci_z * input.sdResidual) / Math.sqrt(input.nGrades),
    isProvisional,
    // A provisional assessor is NEVER flagged and NEVER banded.
    isOutlier: !isProvisional && Math.abs(adjusted) >= d.outlier_abs,
  };
}

// ---------------------------------------------------------------------------
// Two-sided spread
// ---------------------------------------------------------------------------

/**
 * Scales grade spread to [0,1], penalising BOTH tails.
 *
 * A one-sided term scores perfect non-discrimination identically to good
 * calibration: an assessor who awarded the same grade to every competency on
 * every record has a spread of zero and, under a one-sided term, loses nothing.
 * Both tails are a standardisation problem.
 */
export function spreadDeduction(sigma: number | null, cfg: AnalyticsConfig): Maybe<number> {
  if (sigma === null) return notAvailable('INSUFFICIENT');
  const s = cfg.assessor_fairness.spread;
  const excess = Math.max(sigma - s.sigma_floor, 0) / s.sigma_floor;
  const deficit = Math.max(s.sigma_min - sigma, 0) / s.sigma_min;
  return ok(clamp(Math.max(excess, deficit), 0, 1));
}

// ---------------------------------------------------------------------------
// The standardisation index
// ---------------------------------------------------------------------------

export interface AsiInputs {
  /** The ADJUSTED delta. Null when there are no residuals. */
  readonly delta: number | null;
  readonly sigma: number | null;
  /** substantive below-standard remarks / below-standard grades. Null when none awarded. */
  readonly justificationRate: number | null;
  /** halo records / eligible records. Null when no record had enough competencies graded. */
  readonly haloRate: number | null;
  /** OLS slope of residuals per trend.slope_interval_days. Null below the minimum points. */
  readonly drift: number | null;
  /** max(actual - expected, 0). Null when no expectation could be formed. */
  readonly notObservedExcess: number | null;
  readonly nRecords: number;
}

export interface AsiTerm {
  readonly name: AsiTermName;
  readonly points: number;
  readonly scaled: Maybe<number>;
  readonly pointsLost: number;
  readonly available: boolean;
}

export interface AsiResult {
  readonly score: number | null;
  readonly band: AsiBand;
  readonly terms: readonly AsiTerm[];
  readonly availablePoints: number;
  readonly deductions: number;
  readonly caps: readonly string[];
  readonly isProvisional: boolean;
}

export interface AsiCapFlags {
  readonly open_masking_alert?: boolean;
  readonly own_screening_red?: boolean;
  readonly halo_ineligible?: boolean;
}

/**
 * Base less six deductions, RESCALED OVER THE TERMS THAT COULD ACTUALLY FIRE.
 *
 * An unmeasurable term must never act as free credit. Without rescaling, an
 * assessor who never awards a low grade and never grades a full set carries a
 * large block of points that cannot be lost, and scores well on the terms they
 * avoided rather than the terms they passed.
 */
export function standardisationIndex(
  inputs: AsiInputs,
  capFlags: AsiCapFlags,
  cfg: AnalyticsConfig,
): AsiResult {
  const si = cfg.assessor_fairness.standardisation_index;
  const h = cfg.assessor_fairness.habits;

  const scaledTerms: Record<AsiTermName, Maybe<number>> = {
    leniency:
      inputs.delta === null
        ? notAvailable('NOT_APPLICABLE')
        : ok(clamp(Math.abs(inputs.delta) / (si.terms.leniency.scale_full ?? 1), 0, 1)),
    spread: spreadDeduction(inputs.sigma, cfg),
    justification:
      inputs.justificationRate === null
        ? notAvailable('NOT_APPLICABLE')
        : ok(clamp(1 - inputs.justificationRate, 0, 1)),
    halo:
      inputs.haloRate === null
        ? notAvailable('NOT_APPLICABLE')
        : ok(clamp(inputs.haloRate / h.halo.scale_full, 0, 1)),
    drift:
      inputs.drift === null
        ? notAvailable('INSUFFICIENT')
        : ok(clamp(Math.abs(inputs.drift) / h.drift.scale_full, 0, 1)),
    not_observed:
      inputs.notObservedExcess === null
        ? notAvailable('NOT_APPLICABLE')
        : ok(clamp(inputs.notObservedExcess / h.not_observed.scale_full, 0, 1)),
  };

  const terms: AsiTerm[] = (Object.keys(si.terms) as AsiTermName[]).map((name) => {
    const points = si.terms[name].points;
    const scaled = scaledTerms[name];
    return {
      name,
      points,
      scaled,
      available: scaled.ok,
      pointsLost: scaled.ok ? points * scaled.value : 0,
    };
  });

  const availablePoints = si.rescale_over_available_terms
    ? terms.filter((t) => t.available).reduce((a, t) => a + t.points, 0)
    : terms.reduce((a, t) => a + t.points, 0);
  const deductions = terms.reduce((a, t) => a + t.pointsLost, 0);

  const isProvisional =
    inputs.nRecords < cfg.assessor_fairness.adjusted_delta.min_records_banded;

  const score =
    availablePoints > 0 ? si.base * (1 - deductions / availablePoints) : null;

  // ---- caps: a ceiling on the BAND, applied after and independently of the score
  const caps: string[] = [];
  if (capFlags.open_masking_alert) caps.push('open_masking_alert');
  if (capFlags.own_screening_red) caps.push('own_screening_red');
  if (capFlags.halo_ineligible) caps.push('halo_ineligible');

  let band: AsiBand;
  if (isProvisional || score === null) {
    band = 'not_banded';
  } else if (score >= si.bands.green_min) band = 'green';
  else if (score >= si.bands.amber_min) band = 'amber';
  else band = 'red';

  if (band !== 'not_banded') {
    if (caps.length >= 2 && si.caps.two_or_more_caps === 'red') band = 'red';
    else if (caps.length >= 1) band = worseOf(band, 'amber');
  }

  return { score, band, terms, availablePoints, deductions, caps, isProvisional };
}

function worseOf(a: AsiBand, b: AsiBand): AsiBand {
  const order: AsiBand[] = ['green', 'amber', 'red'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type AssessorStatus = 'current' | 'dormant' | 'former';

/**
 * Derived, never stored, and a DISPLAY FILTER ONLY: grades from dormant and
 * former assessors stay in the peer mean and in every current assessor's
 * expected-grade calculation, because removing them changes everyone else's
 * number.
 */
export function assessorStatus(
  input: { hasLogin: boolean; lastGradedOn: string | null },
  asOf: Date,
  cfg: AnalyticsConfig,
): AssessorStatus {
  if (!input.hasLogin) return 'former';
  if (input.lastGradedOn === null) return 'dormant';
  const days = (asOf.getTime() - new Date(input.lastGradedOn).getTime()) / 86_400_000;
  return days > cfg.assessor_fairness.status.dormant_after_days ? 'dormant' : 'current';
}

/** Justification rate. Null when no below-standard grade was awarded: the term is unavailable. */
export function justificationRate(nSubstantive: number, nBelowStandard: number): number | null {
  return nBelowStandard === 0 ? null : nSubstantive / nBelowStandard;
}
