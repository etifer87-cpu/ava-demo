/**
 * lib/analytics/statistics.ts
 *
 * The shared statistical helpers. docs/06_ANALYTICS.md §4.1, §5.5, §14.
 * Pure, deterministic, no configuration of its own beyond what is passed in.
 */

/** Sample standard deviation. Sample, not population: a population sd understates alert spacing. */
export function sdSample(xs: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs) as number;
  const ss = xs.reduce((a, x) => a + (x - m) ** 2, 0);
  return Math.sqrt(ss / (n - 1));
}

export function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, x) => a + x, 0) / xs.length;
}

/**
 * Wilson score interval for a proportion.
 *
 * Used on EVERY displayed rate. Never the normal approximation: at the low rates
 * these indicators operate at, the normal interval extends below zero and
 * reports an impossible lower bound as though it were a measurement.
 */
export function wilson(num: number, den: number, z = 1.96): { lo: number; hi: number } | null {
  if (den <= 0) return null;
  const p = num / den;
  const z2 = z * z;
  const denom = 1 + z2 / den;
  const centre = (p + z2 / (2 * den)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / den + z2 / (4 * den * den))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Two-proportion z test. Used for template equivalence, always Bonferroni-corrected by the caller. */
export function twoProportionZ(
  num1: number, den1: number, num2: number, den2: number,
): { z: number; p: number } | null {
  if (den1 <= 0 || den2 <= 0) return null;
  const p1 = num1 / den1;
  const p2 = num2 / den2;
  const pool = (num1 + num2) / (den1 + den2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / den1 + 1 / den2));
  if (se === 0) return null;
  const z = (p1 - p2) / se;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

/**
 * Bonferroni threshold. The divisor is the number of ACTIVE COMPETENCIES read
 * from the framework at runtime, never a literal: testing one hypothesis per
 * competency at an uncorrected alpha produces a false positive most of the time
 * across a framework of nine, and adding a competency must tighten the
 * threshold automatically.
 */
export function bonferroniAlpha(alpha: number, competencyCount: number): number {
  if (competencyCount < 1) throw new Error('bonferroniAlpha: competencyCount must be at least 1');
  return alpha / competencyCount;
}

export interface WelchResult {
  diff: number;
  ciLo: number;
  ciHi: number;
  df: number;
  t: number;
  cohensD: number;
}

/** Welch comparison of two means. Unequal variances assumed - they always are. */
export function welch(
  a: { mean: number; sd: number; n: number },
  b: { mean: number; sd: number; n: number },
  z = 1.96,
): WelchResult | null {
  if (a.n < 2 || b.n < 2) return null;
  const va = (a.sd * a.sd) / a.n;
  const vb = (b.sd * b.sd) / b.n;
  const se = Math.sqrt(va + vb);
  if (se === 0) return null;
  const diff = a.mean - b.mean;
  const df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
  const pooledSd = Math.sqrt(
    ((a.n - 1) * a.sd * a.sd + (b.n - 1) * b.sd * b.sd) / (a.n + b.n - 2),
  );
  return {
    diff,
    ciLo: diff - z * se,
    ciHi: diff + z * se,
    df,
    t: diff / se,
    cohensD: pooledSd === 0 ? 0 : diff / pooledSd,
  };
}

/** Percentile of a value within a distribution of values, as a proportion in [0,1]. */
export function percentileOf(value: number, population: readonly number[]): number | null {
  if (population.length === 0) return null;
  const below = population.filter((x) => x < value).length;
  const equal = population.filter((x) => x === value).length;
  return (below + equal / 2) / population.length;
}

/** Ordinary least-squares slope of y against x. Returns null below two distinct x values. */
export function olsSlope(points: readonly { x: number; y: number }[]): number | null {
  if (points.length < 2) return null;
  const mx = mean(points.map((p) => p.x)) as number;
  const my = mean(points.map((p) => p.y)) as number;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  return sxx === 0 ? null : sxy / sxx;
}

/**
 * Overdispersion ratio: observed per-period sd of a count, over the Poisson sd
 * implied by its mean. A ratio near 1 means period-to-period movement is
 * indistinguishable from counting noise, and the series should be aggregated to
 * a longer period rather than charted as peaks and troughs that mean nothing.
 */
export function overdispersion(counts: readonly number[]): number | null {
  const m = mean(counts);
  const sd = sdSample(counts);
  if (m === null || sd === null || m <= 0) return null;
  return sd / Math.sqrt(m);
}

/** Abramowitz-Stegun 7.1.26 error function; adequate for a displayed p value. */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
