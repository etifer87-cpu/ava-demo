/**
 * lib/analytics/trend.ts
 *
 * Trend and delta. docs/06_ANALYTICS.md §10.
 *
 * A direction is always reported with the number behind it. An arrow on its own
 * is an assertion; an arrow with a slope and an n is a measurement.
 */

import type { AnalyticsConfig, TrendArrow } from './types';
import { mean, olsSlope } from './statistics';

export interface TrendPoint {
  /** ISO date. Used for spacing in the slope form and for ordering in both. */
  readonly on: string;
  readonly value: number;
}

export interface HalfSplitTrend {
  readonly arrow: TrendArrow;
  readonly delta: number | null;
  readonly n: number;
}

/**
 * Half-split trend: the newer half's mean minus the older half's mean. An odd
 * count leaves the middle point in neither half, so a single central value
 * cannot tip the direction on its own.
 *
 * Returns NONE below trend.min_points. It does not return FLAT: "flat" is a
 * finding, and a finding needs evidence.
 */
export function halfSplitTrend(
  points: readonly TrendPoint[],
  cfg: AnalyticsConfig,
  flatBand = cfg.trend.flat_band,
): HalfSplitTrend {
  const xs = [...points].sort((a, b) => a.on.localeCompare(b.on)).map((p) => p.value);
  if (xs.length < cfg.trend.min_points) return { arrow: 'NONE', delta: null, n: xs.length };
  const half = Math.floor(xs.length / 2);
  const older = mean(xs.slice(0, half));
  const newer = mean(xs.slice(xs.length - half));
  if (older === null || newer === null) return { arrow: 'NONE', delta: null, n: xs.length };
  const delta = newer - older;
  const arrow: TrendArrow = delta > flatBand ? 'UP' : delta < -flatBand ? 'DOWN' : 'FLAT';
  return { arrow, delta, n: xs.length };
}

export interface SlopeTrend {
  /** Change per trend.slope_interval_days. Null below the minimum points. */
  readonly slopePerInterval: number | null;
  readonly n: number;
  readonly arrow: TrendArrow;
}

/** OLS slope against days, rescaled to the configured interval. Always reported with its n. */
export function slopeTrend(points: readonly TrendPoint[], cfg: AnalyticsConfig): SlopeTrend {
  if (points.length < cfg.trend.min_points) {
    return { slopePerInterval: null, n: points.length, arrow: 'NONE' };
  }
  const first = points[0];
  if (first === undefined) return { slopePerInterval: null, n: points.length, arrow: 'NONE' };
  const t0 = new Date(first.on).getTime();
  const slopePerDay = olsSlope(
    points.map((p) => ({ x: (new Date(p.on).getTime() - t0) / 86_400_000, y: p.value })),
  );
  if (slopePerDay === null) return { slopePerInterval: null, n: points.length, arrow: 'NONE' };
  const slope = slopePerDay * cfg.trend.slope_interval_days;
  const arrow: TrendArrow =
    slope > cfg.trend.flat_band ? 'UP' : slope < -cfg.trend.flat_band ? 'DOWN' : 'FLAT';
  return { slopePerInterval: slope, n: points.length, arrow };
}

export interface DeltaPill {
  readonly delta: number | null;
  readonly nLeft: number;
  readonly nRight: number;
  readonly insufficient: boolean;
}

/**
 * A plain difference of two means, with both sample sizes.
 *
 * "Insufficient" is not "no difference". Reporting a thin comparison as "no
 * change" asserts an absence that was never tested.
 */
export function deltaPill(
  left: { mean: number | null; n: number },
  right: { mean: number | null; n: number },
  cfg: AnalyticsConfig,
): DeltaPill {
  const insufficient =
    left.n < cfg.comparison.min_n_per_side ||
    right.n < cfg.comparison.min_n_per_side ||
    left.mean === null ||
    right.mean === null;
  return {
    delta: insufficient ? null : (left.mean as number) - (right.mean as number),
    nLeft: left.n,
    nRight: right.n,
    insufficient,
  };
}
