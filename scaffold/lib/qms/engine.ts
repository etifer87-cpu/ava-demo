/**
 * scaffold/lib/qms/engine.ts
 *
 * The evaluation engine. Pure by contract:
 *   - no I/O, no database handle, no network, no clock;
 *   - every date comparison uses the injected `asOf`, so "what would this rule have said on the
 *     third of March?" is answerable;
 *   - an unknown condition type returns unmet and NOT evaluable - never met, never a throw;
 *   - nothing throws: malformed input resolves to unmet with a machine-readable reason;
 *   - AN EMPTY REQUIREMENT SET IS NEVER MET.
 *
 * Spec: docs/08_QMS.md sections 5 and 6.
 */

import {
  CONDITION_TYPES, type ConditionResult, type Params, type PhraseContext, type QmsEvidence,
  maxDate, minDate, toDay, toISODate, unmet,
} from './conditions';

/* ------------------------------------------------------------ definition */

export interface ConditionSpec {
  condition_key: string;
  type: string;
  params: Params;
  label?: string;
}

export interface RequirementGroup {
  group_key: string;
  label?: string;
  match: 'all' | 'any' | 'n_of';
  n?: number | null;
  conditions: ConditionSpec[];
}

export interface Requirements {
  match: 'all' | 'any' | 'n_of';
  n?: number | null;
  groups: RequirementGroup[];
}

export type ConstraintSpec =
  | { kind: 'after'; subject: string; reference: string }
  | { kind: 'within'; members: string[]; window_days: number };

export interface ValiditySpec {
  mode: 'interval' | 'fixed_date' | 'one_time';
  months?: number | null;
  anchor?: 'last_condition_met' | 'approval' | 'earliest_evidence' | 'fixed';
  anchor_date?: string | null;
  end_of_month?: boolean;
  warning_days?: number;
  early_renewal_days?: number;
  expiry_grace_days?: number;
}

export interface QualDefinition {
  schema_version?: number;
  identity: { code: string; name: string; category: string; framework_id?: string | null };
  applicability?: Record<string, unknown>;
  requirements?: Requirements;
  constraints?: ConstraintSpec[];
  validity?: ValiditySpec;
  approval?: Record<string, unknown>;
}

/* ---------------------------------------------------------------- output */

export interface ConditionOutcome extends ConditionResult {
  condition_key: string;
  group_key: string;
  type: string;
}

export interface GroupOutcome {
  group_key: string;
  met: boolean;
  met_at: string | null;
  satisfied_count: number;
  required_count: number;
  evaluable: boolean;
}

export interface ConstraintOutcome {
  index: number;
  kind: 'after' | 'within';
  status: 'met' | 'violated' | 'not_evaluable';
  detail: Record<string, unknown>;
}

export interface ValidityOutcome {
  anchor_date: string | null;
  valid_from: string | null;
  valid_until: string | null;
  warning_from: string | null;
  early_renewal_from: string | null;
  grace_until: string | null;
  mode: ValiditySpec['mode'];
}

export interface QualEvaluation {
  met: boolean;
  met_at: string | null;
  reason: string;
  conditions: ConditionOutcome[];
  groups: GroupOutcome[];
  constraints: ConstraintOutcome[];
  validity: ValidityOutcome | null;
  errors: string[];
}

/* ------------------------------------------------------------ date maths */

/** Add whole months, clamping the day, then optionally roll to end of month. */
export const addMonths = (iso: string, months: number, endOfMonth = false): string | null => {
  if (toDay(iso) === null) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const day = endOfMonth ? lastDay : Math.min(d, lastDay);
  return new Date(Date.UTC(ny, nm, day)).toISOString().slice(0, 10);
};

const shiftDays = (iso: string | null, days: number): string | null => {
  const d = toDay(iso);
  return d === null ? null : toISODate(d + days);
};

/* ---------------------------------------------------------- aggregation */

const requiredCount = (
  match: 'all' | 'any' | 'n_of',
  n: number | null | undefined,
  total: number,
): number => {
  if (total === 0) return 0;
  if (match === 'all') return total;
  if (match === 'any') return 1;
  const want = typeof n === 'number' ? Math.floor(n) : NaN;
  if (!Number.isFinite(want) || want < 1) return total;   // invalid n_of degrades to all
  return Math.min(want, total);
};

/** Date at which `need` of these results were satisfied: the need-th earliest met_at. */
const satisfiedAt = (dates: (string | null)[], need: number): string | null => {
  const days = dates
    .map((d) => toDay(d))
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  const day = days[need - 1];
  if (need <= 0 || day === undefined) return null;
  return toISODate(day);
};

/* -------------------------------------------------------------- evaluate */

export function evaluate(
  definition: QualDefinition,
  evidence: QmsEvidence,
  asOf: Date | string,
): QualEvaluation {
  const errors: string[] = [];
  const asOfIso = (typeof asOf === 'string' ? asOf : asOf.toISOString()).slice(0, 10);

  const empty = (reason: string): QualEvaluation => ({
    met: false, met_at: null, reason,
    conditions: [], groups: [], constraints: [], validity: null, errors,
  });

  if (toDay(asOfIso) === null) {
    errors.push('invalid_as_of');
    return empty('invalid_as_of');
  }
  if (!definition || typeof definition !== 'object') {
    errors.push('invalid_definition');
    return empty('invalid_definition');
  }

  const groupsIn = Array.isArray(definition.requirements?.groups)
    ? (definition.requirements as Requirements).groups
    : [];

  // ---- THE GUARD. [].every(fn) is true, so without this an unfinished draft satisfies
  // ---- everybody it applies to and the approval queue fills with grants nobody authored.
  const totalConditions = groupsIn.reduce(
    (acc, g) => acc + (Array.isArray(g?.conditions) ? g.conditions.length : 0), 0);
  if (groupsIn.length === 0 || totalConditions === 0) {
    return empty('no_requirements_defined');
  }

  // ---- conditions
  const conditions: ConditionOutcome[] = [];
  const groups: GroupOutcome[] = [];

  for (const group of groupsIn) {
    const specs = Array.isArray(group?.conditions) ? group.conditions : [];
    const results: ConditionOutcome[] = [];

    for (const spec of specs) {
      const key = typeof spec?.condition_key === 'string' ? spec.condition_key : '(unkeyed)';
      const type = typeof spec?.type === 'string' ? spec.type : '(untyped)';
      const registered = CONDITION_TYPES[type];

      let result: ConditionResult;
      if (!registered) {
        // Newer definition than this engine. Degrade to "cannot confirm", never to met.
        errors.push(`unknown_condition_type:${type}`);
        result = unmet('unknown_condition_type', false);
      } else {
        try {
          result = registered.evaluate(spec.params ?? {}, evidence, asOfIso);
        } catch (err) {
          // The engine does not throw. A misbehaving evaluator is an unmet condition.
          errors.push(`evaluator_error:${type}:${(err as Error)?.message ?? 'unknown'}`);
          result = unmet('invalid_params', false);
        }
      }

      const outcome: ConditionOutcome = {
        ...result,
        condition_key: key,
        group_key: group.group_key,
        type,
      };
      results.push(outcome);
      conditions.push(outcome);
    }

    const need = requiredCount(group?.match ?? 'all', group?.n, results.length);
    const metResults = results.filter((r) => r.met);
    const groupMet = results.length > 0 && metResults.length >= need && need > 0;

    groups.push({
      group_key: group.group_key,
      met: groupMet,
      met_at: groupMet ? satisfiedAt(metResults.map((r) => r.met_at), need) : null,
      satisfied_count: metResults.length,
      required_count: need,
      evaluable: results.every((r) => r.evaluable),
    });
  }

  // ---- top level
  const topNeed = requiredCount(
    definition.requirements?.match ?? 'all', definition.requirements?.n, groups.length);
  const metGroups = groups.filter((g) => g.met);
  const rulesMet = groups.length > 0 && topNeed > 0 && metGroups.length >= topNeed;
  const rulesMetAt = rulesMet ? satisfiedAt(metGroups.map((g) => g.met_at), topNeed) : null;

  // ---- constraints
  const constraints = evaluateConstraints(definition.constraints ?? [], conditions, groups);
  const constraintsOk = constraints.every((c) => c.status === 'met');
  const constraintViolated = constraints.some((c) => c.status === 'violated');

  const met = rulesMet && constraintsOk;
  const reason = met ? 'met'
    : constraintViolated ? 'constraint_violated'
    : rulesMet ? 'constraint_not_evaluable'
    : conditions.some((c) => !c.evaluable) ? 'not_evaluable'
    : 'requirements_not_met';

  const validity = met
    ? computeValidity(definition.validity, rulesMetAt, asOfIso, evidence, conditions)
    : null;

  return { met, met_at: met ? rulesMetAt : null, reason, conditions, groups, constraints, validity, errors };
}

/* ------------------------------------------------------------ constraints */

function evaluateConstraints(
  specs: ConstraintSpec[],
  conditions: ConditionOutcome[],
  groups: GroupOutcome[],
): ConstraintOutcome[] {
  const dateOf = (key: string): string | null => {
    const c = conditions.find((x) => x.condition_key === key);
    if (c) return c.met ? c.met_at : null;
    const g = groups.find((x) => x.group_key === key);
    return g && g.met ? g.met_at : null;
  };

  return (Array.isArray(specs) ? specs : []).map((spec, index): ConstraintOutcome => {
    if (spec?.kind === 'after') {
      const subject = dateOf(spec.subject);
      const reference = dateOf(spec.reference);
      if (!subject || !reference) {
        return { index, kind: 'after', status: 'not_evaluable',
          detail: { subject: spec.subject, reference: spec.reference } };
      }
      const ok = (toDay(subject) ?? 0) >= (toDay(reference) ?? 0);
      return { index, kind: 'after', status: ok ? 'met' : 'violated',
        detail: { subject_met_at: subject, reference_met_at: reference } };
    }

    if (spec?.kind === 'within') {
      const members = Array.isArray(spec.members) ? spec.members : [];
      const dates = members.map(dateOf);
      if (members.length === 0 || dates.some((d) => d === null)) {
        return { index, kind: 'within', status: 'not_evaluable', detail: { members } };
      }
      const first = minDate(dates);
      const last = maxDate(dates);
      const spread = (toDay(last) ?? 0) - (toDay(first) ?? 0);
      const ok = spread <= (spec.window_days ?? 0);
      return { index, kind: 'within', status: ok ? 'met' : 'violated',
        detail: { first, last, spread_days: spread, window_days: spec.window_days } };
    }

    return { index, kind: 'within', status: 'not_evaluable', detail: { error: 'unknown_constraint_kind' } };
  });
}

/* -------------------------------------------------------------- validity */

export function computeValidity(
  spec: ValiditySpec | undefined,
  rulesMetAt: string | null,
  asOf: string,
  evidence: QmsEvidence,
  conditions: ConditionOutcome[],
): ValidityOutcome | null {
  const v: ValiditySpec = spec ?? { mode: 'interval', months: 12 };

  if (v.mode === 'one_time') {
    return { anchor_date: rulesMetAt, valid_from: rulesMetAt, valid_until: null,
      warning_from: null, early_renewal_from: null, grace_until: null, mode: 'one_time' };
  }

  if (v.mode === 'fixed_date') {
    // The evidence itself carries the expiry: take the earliest binding one.
    const until = minDate(evidence.documents
      .filter((d) => d.review_state === 'approved' && d.valid_until)
      .map((d) => d.valid_until));
    return withWindows(v, rulesMetAt, rulesMetAt, until, 'fixed_date');
  }

  const anchorMode = v.anchor ?? 'last_condition_met';
  const anchor =
    anchorMode === 'fixed' ? (v.anchor_date ?? null)
    : anchorMode === 'approval' ? asOf
    : anchorMode === 'earliest_evidence'
      ? minDate(conditions.filter((c) => c.met).map((c) => c.met_at))
      : rulesMetAt;

  if (!anchor) return null;

  const months = typeof v.months === 'number' && v.months >= 1 ? Math.floor(v.months) : 12;

  // Early renewal: completing inside the window before the current expiry re-anchors to the OLD
  // expiry, so credit is not lost. Expiry grace is the OTHER window, on the other side, and it
  // never re-anchors. They are two settings and must never be collapsed into one.
  const prior = evidence.priorHolding?.valid_until ?? null;
  const early = v.early_renewal_days ?? 0;
  const priorDay = toDay(prior);
  const anchorDay = toDay(anchor);
  const isEarlyRenewal =
    priorDay !== null && anchorDay !== null && early > 0 &&
    anchorDay <= priorDay && anchorDay >= priorDay - early;

  const base = isEarlyRenewal ? (prior as string) : anchor;
  const until = addMonths(base, months, v.end_of_month === true);

  return withWindows(v, anchor, anchor, until, 'interval');
}

function withWindows(
  v: ValiditySpec,
  anchor: string | null,
  validFrom: string | null,
  validUntil: string | null,
  mode: ValiditySpec['mode'],
): ValidityOutcome {
  return {
    anchor_date: anchor,
    valid_from: validFrom,
    valid_until: validUntil,
    warning_from: shiftDays(validUntil, -(v.warning_days ?? 0)),
    early_renewal_from: shiftDays(validUntil, -(v.early_renewal_days ?? 0)),
    grace_until: shiftDays(validUntil, v.expiry_grace_days ?? 0),
    mode,
  };
}

/* ---------------------------------------------------------------- status */

export type QualStatus =
  | 'valid' | 'warning' | 'expired' | 'suspended' | 'inactive' | 'missing' | 'pending_approval';

export interface HoldingLike {
  valid_from: string | null;
  valid_until: string | null;
  status_override: 'suspended' | 'inactive' | null;
  has_open_approval?: boolean;
}

/**
 * Derived on read, always. There is no status column: a stored status is only as fresh as the
 * last successful job, and nothing about the row says how stale it is.
 */
export function deriveStatus(
  holding: HoldingLike | null,
  validity: Pick<ValiditySpec, 'warning_days' | 'expiry_grace_days'> | undefined,
  asOf: Date | string,
): QualStatus {
  const asOfDay = toDay(typeof asOf === 'string' ? asOf : asOf.toISOString().slice(0, 10));
  if (!holding) return 'missing';
  if (holding.status_override === 'suspended') return 'suspended';
  if (holding.status_override === 'inactive') return 'inactive';
  if (!holding.valid_from && !holding.valid_until) {
    return holding.has_open_approval ? 'pending_approval' : 'missing';
  }
  if (asOfDay === null) return 'missing';

  const until = toDay(holding.valid_until);
  if (until === null) return 'valid';                     // one-time: no expiry

  const grace = validity?.expiry_grace_days ?? 0;
  const warn = validity?.warning_days ?? 0;

  if (asOfDay > until + grace) return 'expired';
  if (asOfDay > until) return 'warning';                  // inside the grace window
  if (asOfDay >= until - warn) return 'warning';
  return 'valid';
}

/** Presentation only. `planned` is never persisted and is never a database value. */
export const displayStatus = (status: QualStatus, hasUpcomingPlan: boolean): string =>
  status === 'warning' && hasUpcomingPlan ? 'planned' : status;

export type { PhraseContext };
