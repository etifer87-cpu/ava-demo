/**
 * lib/analytics/program-indicator.ts
 *
 * PLI - the program-level indicator. docs/06_ANALYTICS.md §5.
 *
 * A wrapper around any rate metric: it adds a FROZEN baseline, three alert
 * levels, a target and a status engine with run rules. It is the only metric in
 * the platform that carries an alert status, and the only one whose base is
 * never recomputed automatically.
 *
 * Everything here operates on PROPORTIONS. Display scaling happens in
 * display.ts, at render, to values and reference lines together.
 */

import type { AnalyticsConfig, Band, RateRow } from './types';
import { sdSample, wilson, overdispersion } from './statistics';

export interface IndicatorBase {
  /** POOLED over the base window: sum(num) / sum(den). Never the mean of the period rates. */
  readonly baseRate: number;
  /** SAMPLE sd of the PER-PERIOD rates. A population sd understates the alert spacing. */
  readonly sd: number;
  readonly alerts: readonly number[];
  readonly target: number;
  readonly basePeriodsObserved: number;
  readonly basePeriodsConfigured: number;
  /** The deploy assertion. False means a join fanned out; the RATE will still look plausible. */
  readonly basePeriodsOk: boolean;
  /** Printed unprompted when the base is noisy relative to its own level. */
  readonly sdCaveat: boolean;
}

export interface IndicatorPoint {
  readonly period: string;
  readonly num: number;
  readonly den: number;
  readonly rate: number | null;          // null when suppressed
  readonly ci: { lo: number; hi: number } | null;
  readonly status: Band;
  readonly suppressed: boolean;
  /** Consecutive periods above target, including this one. Diagnostic, for the tooltip. */
  readonly runAboveTarget: number;
  readonly runAtAlert1: number;
}

/**
 * Computes the frozen base statistics from the rows inside the configured base
 * window. The caller selects those rows; this function never looks at a clock
 * and never re-derives the window, because a base that drifts with the data
 * makes improvement permanently invisible.
 */
export function computeBase(
  baseRows: readonly RateRow[],
  basePeriodsConfigured: number,
  cfg: AnalyticsConfig,
): IndicatorBase | null {
  if (baseRows.length === 0) return null;

  const num = baseRows.reduce((a, r) => a + r.num, 0);
  const den = baseRows.reduce((a, r) => a + r.den, 0);
  if (den === 0) return null;

  const baseRate = num / den;
  const periodRates = baseRows.filter((r) => r.den > 0).map((r) => r.num / r.den);
  const sd = sdSample(periodRates) ?? 0;

  const t = cfg.program_indicator.target;
  const target = t.type === 'absolute' ? t.value : baseRate * (1 - t.value);

  return {
    baseRate,
    sd,
    alerts: cfg.program_indicator.alert_sigma.map((k) => baseRate + k * sd),
    target,
    basePeriodsObserved: baseRows.length,
    basePeriodsConfigured,
    basePeriodsOk: baseRows.length === basePeriodsConfigured,
    sdCaveat: sd > baseRate * cfg.program_indicator.sd_caveat_ratio,
  };
}

/**
 * The status engine. docs/06_ANALYTICS.md §5.2.
 *
 * Two asymmetries here are deliberate and must survive any refactor:
 *   - a period at or below target RESETS both runs; improvement clears the record;
 *   - a SUPPRESSED period BREAKS a run rather than continuing it, because
 *     absence of evidence must not accumulate as evidence.
 */
export function computeSeries(
  rows: readonly RateRow[],
  base: IndicatorBase,
  cfg: AnalyticsConfig,
): IndicatorPoint[] {
  const minN = cfg.suppression.min_n_rate;
  const rules = cfg.program_indicator.status_rules;
  const [alert1, alert2] = base.alerts;
  // Fail loud rather than default. The status rules name alert 1 and alert 2; a configuration with
  // fewer than two sigma levels cannot express them, and substituting a level here would be a
  // threshold invented in code - exactly what analytics.yaml exists to prevent.
  if (alert1 === undefined || alert2 === undefined) {
    throw new Error(
      'program_indicator.alert_sigma must configure at least two levels; ' +
        `received ${base.alerts.length}. Fix analytics.yaml, not this function.`,
    );
  }

  const sorted = [...rows].sort((a, b) => a.period.localeCompare(b.period));
  let runAboveTarget = 0;
  let runAtAlert1 = 0;

  return sorted.map((r) => {
    if (r.den < minN) {
      if (rules.suppressed_breaks_run) {
        runAboveTarget = 0;
        runAtAlert1 = 0;
      }
      return {
        period: r.period, num: r.num, den: r.den, rate: null, ci: null,
        status: 'SUPPRESSED' as Band, suppressed: true, runAboveTarget, runAtAlert1,
      };
    }

    const rate = r.num / r.den;

    if (rate <= base.target) {
      runAboveTarget = 0;
      runAtAlert1 = 0;
      return {
        period: r.period, num: r.num, den: r.den, rate,
        ci: wilson(r.num, r.den, cfg.comparison.ci_z),
        status: 'GREEN' as Band, suppressed: false, runAboveTarget, runAtAlert1,
      };
    }

    const atAlert1 = rate >= alert1;
    const nextRunAtAlert1 = atAlert1 ? runAtAlert1 + 1 : 0;
    const nextRunAboveTarget = runAboveTarget + 1;

    let status: Band;
    if (rate >= alert2 || nextRunAtAlert1 >= rules.consecutive_at_alert1) status = 'RED';
    else status = 'AMBER';   // any period above target is already amber; the
                             // consecutive_above_target rule becomes load-bearing
                             // only when an operator sets a target above alert1,
                             // and is kept because the RULE SET, not the
                             // arithmetic, is what an authority reviews.
    if (status === 'AMBER' && nextRunAboveTarget >= rules.consecutive_above_target) status = 'AMBER';

    runAboveTarget = nextRunAboveTarget;
    runAtAlert1 = nextRunAtAlert1;

    return {
      period: r.period, num: r.num, den: r.den, rate,
      ci: wilson(r.num, r.den, cfg.comparison.ci_z),
      status, suppressed: false, runAboveTarget, runAtAlert1,
    };
  });
}

/**
 * Period-length advice. Compute this BEFORE publishing a scope at a given
 * period length: a series whose observed variation is indistinguishable from
 * counting noise should be aggregated up, not charted as peaks and troughs that
 * mean nothing and invite explanations of randomness.
 */
export function periodAdvice(
  baseRows: readonly RateRow[],
  cfg: AnalyticsConfig,
): { ratio: number | null; aggregateUp: boolean } {
  const ratio = overdispersion(baseRows.map((r) => r.num));
  return {
    ratio,
    aggregateUp: ratio !== null && ratio < cfg.program_indicator.overdispersion_warn_below,
  };
}

/**
 * The headline point for a tile: the last COMPLETE period, with the partial one
 * flagged rather than silently included. Values are read from the same rows the
 * chart drew; nothing is recomputed here beyond selection.
 */
export function headline(
  points: readonly IndicatorPoint[],
  isPeriodComplete: (period: string) => boolean,
): { point: IndicatorPoint | null; partial: boolean } {
  const last = points[points.length - 1];
  if (last === undefined) return { point: null, partial: false };
  if (isPeriodComplete(last.period)) return { point: last, partial: false };
  const prior = points.slice(0, -1).reverse().find((p) => !p.suppressed) ?? null;
  return { point: prior, partial: true };
}
