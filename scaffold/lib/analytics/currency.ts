/**
 * lib/analytics/currency.ts
 *
 * Qualification currency and expiry. docs/06_ANALYTICS.md §12.
 *
 * Derived ON READ from an injected `asOf`. Never stored: a stored status is
 * wrong the day after it is written, and an as-at compliance report cannot be
 * reproduced from one.
 */

import type { AnalyticsConfig, CurrencyStatus } from './types';

export interface QualificationInput {
  readonly qualificationId: string;
  readonly validUntil: string | null;      // ISO date; already computed by av_qualification_input
  readonly lastCompletedOn: string | null;
  readonly statusOverride: CurrencyStatus | null;
  readonly isOneTime: boolean;
  readonly warningDays: number | null;
  readonly graceDays: number | null;
  readonly hasOpenPlan: boolean;
}

export interface CurrencyResult {
  readonly status: CurrencyStatus;
  readonly daysRemaining: number | null;
  readonly isDue: boolean;
  readonly countsTowardCompliance: boolean;
}

/** Evaluated in order; the first match wins. The order itself is the specification. */
export function deriveStatus(
  q: QualificationInput,
  asOf: Date,
  cfg: AnalyticsConfig,
): CurrencyResult {
  const warningDays = q.warningDays ?? cfg.currency.default_warning_days;
  const graceDays = q.graceDays ?? cfg.currency.default_grace_days;

  const status = ((): CurrencyStatus => {
    // 1. a manual override wins over everything, including an expiry in the past
    if (q.statusOverride === 'SUSPENDED' || q.statusOverride === 'INACTIVE') return q.statusOverride;
    // 2. no evidence of any kind
    if (q.validUntil === null && q.lastCompletedOn === null) return 'MISSING';
    // 3. a one-time qualification with a completion date does not expire
    if (q.isOneTime) return q.lastCompletedOn !== null ? 'VALID' : 'MISSING';
    if (q.validUntil === null) return 'MISSING';

    const days = daysBetween(asOf, new Date(q.validUntil));
    // 4. past expiry, and past any grace window
    if (days < -graceDays) return 'EXPIRED';
    // 5. a renewal already in flight is its own state, not a warning
    if (q.hasOpenPlan) return 'PLANNED';
    // 6. inside the warning window
    if (days <= warningDays) return 'WARNING';
    return 'VALID';
  })();

  const daysRemaining = q.validUntil === null ? null : daysBetween(asOf, new Date(q.validUntil));

  // DUE is a separate question from status, computed separately for that reason.
  const isDue =
    daysRemaining !== null &&
    daysRemaining <= cfg.currency.due_soon_days &&
    !(cfg.currency.planned_excluded_from_due && status === 'PLANNED');

  return {
    status,
    daysRemaining,
    isDue,
    countsTowardCompliance: cfg.currency.compliant_statuses.includes(status),
  };
}

/**
 * Compliance percentage over a set of required qualifications. Which statuses
 * count is configuration (currency.compliant_statuses), because operators
 * genuinely disagree about whether a planned renewal counts as compliant.
 */
export function compliance(results: readonly CurrencyResult[]): number | null {
  if (results.length === 0) return null;      // no requirement is not 100 per cent
  return results.filter((r) => r.countsTowardCompliance).length / results.length;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
