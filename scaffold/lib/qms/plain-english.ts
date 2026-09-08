/**
 * scaffold/lib/qms/plain-english.ts
 *
 * The single definition-to-English renderer. The builder preview, the version diff, the review
 * screen, the approval queue and the subject profile all call into this file and nothing else.
 *
 * The reason it is one module: an approver who cannot read the rule cannot defend the grant, and
 * three renderers drift. If a surface needs a different shape, it selects a different part of the
 * SAME rendered structure - it does not write its own sentences.
 *
 * Every string here is display text. Nothing in this file is ever used for matching.
 *
 * Spec: docs/08_QMS.md sections 3, 4 and 8.
 */

import { CONDITION_TYPES, type PhraseContext } from './conditions';
import type {
  ConditionOutcome, ConditionSpec, ConstraintSpec, QualDefinition, QualEvaluation,
  RequirementGroup, ValiditySpec,
} from './engine';

/* ----------------------------------------------------------------- shape */

export interface RenderedClause {
  /** Stable key so a surface can attach a tick, a date or a link without re-parsing text. */
  key: string;
  text: string;
  /** True when this clause cannot be evaluated yet - a stubbed condition type. */
  pending_feed: boolean;
}

export interface RenderedGroup {
  group_key: string;
  heading: string;
  clauses: RenderedClause[];
}

export interface RenderedDefinition {
  title: string;
  subtitle: string;
  applies_to: string;
  requirements_lead: string;
  groups: RenderedGroup[];
  constraints: string[];
  validity: string[];
  approval: string[];
  warnings: string[];
  /** The whole thing as flowing text, for a PDF or an email. */
  paragraphs: string[];
}

/* --------------------------------------------------------------- helpers */

const nameOf = (ctx: PhraseContext, id: unknown): string =>
  (ctx.labels && typeof id === 'string' && ctx.labels[id]) || String(id ?? '');

const joinList = (items: string[], conjunction: 'and' | 'or'): string => {
  const parts = items.filter((x) => x && x.length > 0);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} ${conjunction} ${parts[parts.length - 1]}`;
};

const matchLead = (match: string, n: number | null | undefined, total: number): string => {
  if (match === 'any') return 'any one of';
  if (match === 'n_of' && typeof n === 'number' && n >= 1) return `at least ${n} of the ${total}`;
  return 'all of';
};

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

const dateText = (iso: string | null | undefined): string => (iso ? iso : 'not recorded');

/* ------------------------------------------------------------- one clause */

export function renderCondition(spec: ConditionSpec, ctx: PhraseContext = {}): RenderedClause {
  const type = CONDITION_TYPES[spec?.type];
  if (!type) {
    return {
      key: spec?.condition_key ?? '(unkeyed)',
      text: `an unrecognised requirement of type "${spec?.type ?? 'unknown'}" - this version of the ` +
        'application cannot evaluate it and will treat it as not met',
      pending_feed: false,
    };
  }

  let text: string;
  try {
    text = type.phrase(spec.params ?? {}, ctx);
  } catch {
    text = `${type.label} (this requirement could not be described from its settings)`;
  }

  return {
    key: spec.condition_key,
    text: spec.label ? `${spec.label}: ${text}` : text,
    pending_feed: type.status === 'stubbed',
  };
}

export function renderGroup(group: RequirementGroup, ctx: PhraseContext = {}): RenderedGroup {
  const conditions = Array.isArray(group?.conditions) ? group.conditions : [];
  const lead = matchLead(group?.match ?? 'all', group?.n, conditions.length);
  const heading = group?.label
    ? `${group.label} - ${lead} the following:`
    : `${lead} the following:`;
  return {
    group_key: group?.group_key ?? '(unkeyed)',
    heading: heading.charAt(0).toUpperCase() + heading.slice(1),
    clauses: conditions.map((c) => renderCondition(c, ctx)),
  };
}

/* ------------------------------------------------------------ constraints */

export function renderConstraint(spec: ConstraintSpec, ctx: PhraseContext = {}): string {
  if (spec?.kind === 'after') {
    return `${nameOf(ctx, spec.subject)} must be completed after ${nameOf(ctx, spec.reference)}.`;
  }
  if (spec?.kind === 'within') {
    const members = Array.isArray(spec.members) ? spec.members.map((m) => nameOf(ctx, m)) : [];
    return `${joinList(members, 'and')} must all fall within ${spec.window_days} ` +
      `${plural(spec.window_days, 'day')} of each other.`;
  }
  return 'An unrecognised ordering rule is present and will not be evaluated.';
}

/* --------------------------------------------------------------- validity */

export function renderValidity(v: ValiditySpec | undefined): string[] {
  const out: string[] = [];
  const spec: ValiditySpec = v ?? { mode: 'interval', months: 12 };

  if (spec.mode === 'one_time') {
    out.push('Once granted, this qualification does not expire.');
  } else if (spec.mode === 'fixed_date') {
    out.push('The expiry date is taken from the supporting document itself.');
  } else {
    const months = spec.months ?? 12;
    const anchor =
      spec.anchor === 'approval' ? 'the date of approval'
      : spec.anchor === 'earliest_evidence' ? 'the earliest supporting evidence'
      : spec.anchor === 'fixed' ? `the fixed date ${dateText(spec.anchor_date)}`
      : 'the date the last requirement was met';
    out.push(`Valid for ${months} ${plural(months, 'month')} from ${anchor}` +
      (spec.end_of_month === true
        ? ', rolled forward to the last day of that month.'
        : '.'));
  }

  if (spec.mode !== 'one_time') {
    const warn = spec.warning_days ?? 0;
    if (warn > 0) out.push(`A warning is raised ${warn} ${plural(warn, 'day')} before expiry.`);

    // The two windows are described separately and in opposite directions, deliberately: merging
    // them is how a renewal quietly shortens someone's validity every cycle.
    const early = spec.early_renewal_days ?? 0;
    if (early > 0) {
      out.push(`Renewal completed up to ${early} ${plural(early, 'day')} BEFORE expiry counts as ` +
        'on time: the new expiry runs from the old expiry date, so no validity is lost.');
    }
    const grace = spec.expiry_grace_days ?? 0;
    if (grace > 0) {
      out.push(`A grace period of ${grace} ${plural(grace, 'day')} AFTER expiry is tolerated. ` +
        'Renewal inside grace runs from the completion date, and the gap is recorded.');
    } else {
      out.push('There is no grace period after expiry.');
    }
  }

  return out;
}

/* --------------------------------------------------------------- approval */

export function renderApproval(approval: Record<string, unknown> | undefined): string[] {
  const mode = typeof approval?.mode === 'string' ? approval.mode : 'single';
  const out: string[] = [
    'This qualification is never granted automatically. When every requirement is met an alert is ' +
    'raised for a person to approve against the evidence.',
  ];
  if (mode === 'two_step') {
    out.push('Two different people must approve: the second approver cannot be the first.');
  } else if (mode === 'waiver') {
    out.push('A waiver may be granted against unmet requirements. It requires a written reason, ' +
      'records what was unmet, and is reported separately from compliant grants.');
  } else {
    out.push('One approver holding the qualification-approval permission decides.');
  }
  if (approval?.requires_attestation === true) {
    out.push(`Approval is blocked until a current "${String(approval.attestation_key ?? '')}" ` +
      'attestation is on file.');
  }
  out.push('The approver re-enters their own password before the decision is recorded.');
  return out;
}

/* ------------------------------------------------------- applicability */

export function renderApplicability(
  applicability: Record<string, unknown> | undefined,
  ctx: PhraseContext = {},
): string {
  const parts: string[] = [];
  const push = (key: string, noun: string) => {
    const arr = applicability?.[key];
    if (Array.isArray(arr) && arr.length > 0) {
      parts.push(`${noun} ${joinList(arr.map((x) => nameOf(ctx, x)), 'or')}`);
    }
  };
  push('org_unit_ids', 'in');
  push('asset_class_ids', 'on');
  push('positions', 'holding the position of');
  push('instructor_roles', 'acting as');

  const conjunction = applicability?.match === 'any' ? 'or' : 'and';
  const base = parts.length === 0 ? 'Required of everyone' : `Required of people ${joinList(parts, conjunction)}`;

  const excluded = applicability?.exclude_person_ids;
  const suffix = Array.isArray(excluded) && excluded.length > 0
    ? `, except ${excluded.length} named ${plural(excluded.length, 'exclusion')}.`
    : '.';
  return base + suffix;
}

/* ------------------------------------------------------ whole definition */

export function renderDefinition(
  definition: QualDefinition,
  ctx: PhraseContext = {},
): RenderedDefinition {
  const warnings: string[] = [];
  const groups = Array.isArray(definition?.requirements?.groups)
    ? definition.requirements!.groups
    : [];

  const total = groups.reduce(
    (acc, g) => acc + (Array.isArray(g?.conditions) ? g.conditions.length : 0), 0);

  if (total === 0) {
    warnings.push('This definition has no requirements. It cannot be published, and it would ' +
      'never be met if it were.');
  }

  const rendered = groups.map((g) => renderGroup(g, ctx));
  if (rendered.some((g) => g.clauses.some((c) => c.pending_feed))) {
    warnings.push('Some requirements depend on a data feed that is not connected yet. They are ' +
      'shown here, they are saved, and they are reported as "cannot be confirmed" - never as met.');
  }

  const constraints = (definition?.constraints ?? []).map((c) => renderConstraint(c, ctx));
  const validity = renderValidity(definition?.validity);
  const approval = renderApproval(definition?.approval);
  const appliesTo = renderApplicability(definition?.applicability, ctx);
  const lead = `${matchLead(definition?.requirements?.match ?? 'all', definition?.requirements?.n,
    groups.length)} the following ${plural(groups.length, 'group')} must be satisfied:`;

  const paragraphs: string[] = [
    appliesTo,
    lead.charAt(0).toUpperCase() + lead.slice(1),
    ...rendered.flatMap((g) => [g.heading, ...g.clauses.map((c) =>
      `- ${c.text}${c.pending_feed ? ' (cannot be confirmed yet)' : ''}`)]),
    ...constraints,
    ...validity,
    ...approval,
  ];

  return {
    title: definition?.identity?.name ?? '(unnamed qualification)',
    subtitle: `${definition?.identity?.category ?? 'uncategorised'} - code ${definition?.identity?.code ?? '?'}`,
    applies_to: appliesTo,
    requirements_lead: lead.charAt(0).toUpperCase() + lead.slice(1),
    groups: rendered,
    constraints,
    validity,
    approval,
    warnings,
    paragraphs,
  };
}

/* --------------------------------------------- evidence-annotated output */

/**
 * The approval queue and the profile need the same sentences with the outcome attached: what was
 * required, whether it is met, and WHEN. Same clauses, one extra column.
 */
export interface AnnotatedClause extends RenderedClause {
  met: boolean;
  evaluable: boolean;
  met_at: string | null;
  outcome_text: string;
}

export function annotate(
  definition: QualDefinition,
  evaluation: QualEvaluation,
  ctx: PhraseContext = {},
): { groups: { group_key: string; heading: string; clauses: AnnotatedClause[] }[]; summary: string } {
  const byKey = new Map<string, ConditionOutcome>();
  for (const c of evaluation.conditions) byKey.set(c.condition_key, c);

  const groups = renderDefinition(definition, ctx).groups.map((g) => ({
    group_key: g.group_key,
    heading: g.heading,
    clauses: g.clauses.map((c): AnnotatedClause => {
      const outcome = byKey.get(c.key);
      const evaluable = outcome?.evaluable !== false;
      const met = outcome?.met === true;
      return {
        ...c,
        met,
        evaluable,
        met_at: outcome?.met_at ?? null,
        outcome_text: !evaluable
          ? (outcome?.reason === 'feed_unavailable'
            ? 'Cannot be confirmed: the supporting data feed is not connected'
            : 'Cannot be confirmed')
          : met
            ? `Met on ${dateText(outcome?.met_at)}`
            : outcomeReason(outcome),
      };
    }),
  }));

  const summary = evaluation.met
    ? `All requirements met on ${dateText(evaluation.met_at)}. Awaiting approval.`
    : evaluation.reason === 'no_requirements_defined'
      ? 'This qualification has no requirements defined and cannot be met.'
      : evaluation.reason === 'constraint_violated'
        ? 'Every requirement is met, but an ordering or timing rule is not satisfied.'
        : 'Not all requirements are met.';

  return { groups, summary };
}

function outcomeReason(outcome: ConditionOutcome | undefined): string {
  switch (outcome?.reason) {
    case 'threshold_not_reached': {
      const d = outcome.detail as { have?: unknown; need?: unknown } | undefined;
      return d && d.have !== undefined && d.need !== undefined
        ? `Not yet met: ${String(d.have)} of ${String(d.need)}`
        : 'Not yet met';
    }
    case 'not_valid_as_of': return 'Not valid on this date';
    case 'outside_window': return 'Outside the required window';
    case 'invalid_params': return 'This requirement is misconfigured and cannot be evaluated';
    case 'unknown_condition_type': return 'Cannot be confirmed by this version of the application';
    default: return 'No matching evidence found';
  }
}

/* ------------------------------------------------------------------ diff */

/**
 * The version diff is rendered as English on BOTH sides, never as a JSON diff: the person
 * approving a rule change is reading a rule, not a document.
 */
export interface DiffLine {
  change: 'added' | 'removed' | 'unchanged';
  text: string;
}

export function renderDiff(
  before: QualDefinition | null,
  after: QualDefinition,
  ctx: PhraseContext = {},
): DiffLine[] {
  const a = before ? renderDefinition(before, ctx).paragraphs : [];
  const b = renderDefinition(after, ctx).paragraphs;
  const inA = new Set(a);
  const inB = new Set(b);

  const lines: DiffLine[] = [];
  for (const line of a) if (!inB.has(line)) lines.push({ change: 'removed', text: line });
  for (const line of b) lines.push({ change: inA.has(line) ? 'unchanged' : 'added', text: line });
  return lines;
}
