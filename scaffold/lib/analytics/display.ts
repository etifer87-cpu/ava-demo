/**
 * lib/analytics/display.ts
 *
 * Display scaling for rates. docs/06_ANALYTICS.md §4.1, §4.2; docs/07 §2.
 *
 * The ONLY place a proportion becomes a displayed number. Views, routes and the
 * status engine all stay on proportions in [0,1]; the display denominator is
 * applied here, to values AND to reference lines together. A single positive
 * constant cannot reorder values against thresholds - but only because both
 * sides pass through this one function.
 */

import type { AnalyticsConfig, RateDisplay } from './types';

export function rateDisplay(metric: string, cfg: AnalyticsConfig): RateDisplay {
  const d = cfg.rate_display[metric];
  if (!d) {
    // Fail loudly. A missing entry means a metric was published without deciding
    // what its exposure is, and the fallback would be someone else's unit.
    throw new Error(`analytics.yaml rate_display has no entry for metric "${metric}"`);
  }
  return d;
}

/** Scales one proportion for display. Returns null unchanged: a suppressed period stays absent. */
export function scaleRate(rate: number | null, metric: string, cfg: AnalyticsConfig): number | null {
  if (rate === null) return null;
  return rate * rateDisplay(metric, cfg).denominator;
}

/**
 * Formats a rate together with the unit that belongs to it.
 *
 * The unit always travels with the number. The two headline metrics have
 * different denominators - one counts grade events, the other counts records -
 * so a shared "per N" string overstates one of them by roughly the number of
 * competencies graded per record. There is deliberately no function here that
 * returns a bare formatted number.
 */
export function formatRate(
  rate: number | null,
  metric: string,
  cfg: AnalyticsConfig,
  fractionDigits = 1,
): { text: string; unit: string; axisLabel: string } {
  const d = rateDisplay(metric, cfg);
  const scaled = scaleRate(rate, metric, cfg);
  return {
    text: scaled === null ? `n<${cfg.suppression.min_n_rate}` : scaled.toFixed(fractionDigits),
    unit: d.unit,
    axisLabel: d.axis_label,
  };
}

/** Scales a threshold with exactly the same constant, so a comparison cannot be reordered. */
export function scaleThreshold(value: number | null, metric: string, cfg: AnalyticsConfig): number | null {
  return scaleRate(value, metric, cfg);
}
