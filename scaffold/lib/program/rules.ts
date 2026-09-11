/**
 * lib/program/rules.ts - the findings bar's predicates.
 *
 * config/rules.yaml carries the parameters and the words; this file carries one predicate per
 * rule id. `assertRegistryComplete` checks the two sets match in both directions and is called by
 * the server wrapper at load and by the test suite, so a rule added on one side and not the other
 * fails before it reaches a screen. docs/06_PROGRAM_BUILDER.md section 6.
 *
 * PURE: the registry is passed in, the tree is passed in, findings come out.
 */

import { formatMinutes, type SlotRef } from './shape';
import { isTrainingOnly, phaseOf, plannedMinutes, sectionsOf, tasksOf, totalPlannedMinutes, walk, type ProgramTree } from './model';

export type Severity = 'block' | 'warn';

export interface RuleSpec {
  readonly id: string;
  readonly severity: Severity;
  readonly applies_to_kinds?: readonly string[];
  readonly params?: Readonly<Record<string, unknown>>;
  readonly source?: string;
  readonly message: string;
}

export interface RuleRegistry {
  readonly version: string;
  readonly rules: readonly RuleSpec[];
}

export interface Finding {
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  /** What the finding cites, for the label beside it. */
  readonly source: string | null;
  /** The element the finding points at; null when it concerns the version as a whole. */
  readonly at: string | null;
  /** A short detail with the numbers, e.g. "3:45 of 4:00". */
  readonly detail: string | null;
}

type Predicate = (tree: ProgramTree, rule: RuleSpec) => readonly Finding[];

function finding(rule: RuleSpec, at: string | null, detail: string | null = null): Finding {
  return { rule: rule.id, severity: rule.severity, message: rule.message, source: rule.source ?? null, at, detail };
}

function strings(rule: RuleSpec, key: string): readonly string[] {
  const v = rule.params?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function num(rule: RuleSpec, key: string, fallback: number): number {
  const v = rule.params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function slotsOf(tree: ProgramTree): { key: string; slot: SlotRef }[] {
  const out: { key: string; slot: SlotRef }[] = [];
  for (const n of walk(tree.roots)) {
    if (n.content.type === 'task' && n.content.task.conduct.slot) out.push({ key: n.key, slot: n.content.task.conduct.slot });
    if (n.content.type === 'event_option' && n.content.options.slot) out.push({ key: n.key, slot: n.content.options.slot });
  }
  return out;
}

/** The implementations. The key set of this object IS the contract with rules.yaml. */
export const RULE_IMPLEMENTATIONS: Readonly<Record<string, Predicate>> = {
  'ebt.three_phases': (tree, rule) => {
    const wanted = strings(rule, 'phases');
    const present = new Set(sectionsOf(tree).map((s) => (s.content.type === 'section' ? s.content.section.phase : null)).filter((p): p is string => p !== null));
    const missing = wanted.filter((p) => !present.has(p));
    return missing.length ? [finding(rule, null, `missing: ${missing.join(', ')}`)] : [];
  },

  'time.budget': (tree, rule) => {
    const period = tree.setup.period_minutes;
    const planned = totalPlannedMinutes(tree);
    if (period === null || planned === null) return [];          // nothing stated, nothing to measure
    const tolerance = num(rule, 'tolerance_minutes', 0);
    if (Math.abs(planned - period) <= tolerance) return [];
    return [finding(rule, null, `${formatMinutes(planned)} of ${formatMinutes(period)}`)];
  },

  'reinf.present': (tree, rule) => {
    const phase = String(rule.params?.phase ?? '');
    const min = num(rule, 'min_minutes', 1);
    const reinf = sectionsOf(tree).filter((s) => s.content.type === 'section' && s.content.section.phase === phase);
    if (reinf.length === 0) return [finding(rule, null, 'no reinforcement section')];
    const total = reinf.reduce<number>((acc, s) => acc + (plannedMinutes(s) ?? 0), 0);
    return total < min ? [finding(rule, reinf[0]?.key ?? null, `${formatMinutes(total)} planned, minimum ${formatMinutes(min)}`)] : [];
  },

  'training_only.not_graded': (tree, rule) => {
    const phases = new Set(strings(rule, 'phases'));
    const out: Finding[] = [];
    for (const t of tasksOf(tree)) {
      if (t.content.type !== 'task') continue;
      const g = t.content.task.grading;
      const graded = g.task_outcome_mode !== 'none' || g.competency_grade_mode !== 'none';
      if (!graded) continue;
      const phase = phaseOf(tree, t);
      if (isTrainingOnly(tree, t) || (phase !== null && phases.has(phase))) out.push(finding(rule, t.key, phase ? `phase ${phase}` : 'training-only section'));
    }
    return out;
  },

  'task.max_competencies': (tree, rule) => {
    const max = num(rule, 'max', 3);
    const out: Finding[] = [];
    for (const t of tasksOf(tree)) {
      if (t.content.type !== 'task') continue;
      const n = t.content.task.grading.competencies.length;
      if (n > max) out.push(finding(rule, t.key, `${n} targeted, guardrail ${max}`));
    }
    return out;
  },

  'task.grading_criteria': (tree, rule) => {
    const out: Finding[] = [];
    for (const t of tasksOf(tree)) {
      if (t.content.type !== 'task') continue;
      const g = t.content.task.grading;
      const graded = g.task_outcome_mode !== 'none' || g.competency_grade_mode !== 'none';
      if (graded && !t.content.task.aims.grading_criteria) out.push(finding(rule, t.key));
    }
    return out;
  },

  'slot.constraints_unevaluated': (tree, rule) =>
    slotsOf(tree)
      .filter(({ slot }) => slot.no_repeat_within_modules !== null || slot.cycle_coverage)
      .map(({ key, slot }) => finding(rule, key, [slot.no_repeat_within_modules !== null ? `no repeat within ${slot.no_repeat_within_modules} modules` : null, slot.cycle_coverage ? 'cycle coverage' : null].filter(Boolean).join(' · '))),
};

/** Throws when rules.yaml and RULE_IMPLEMENTATIONS disagree, naming every id on the wrong side. */
export function assertRegistryComplete(registry: RuleRegistry): void {
  const declared = new Set(registry.rules.map((r) => r.id));
  const implemented = new Set(Object.keys(RULE_IMPLEMENTATIONS));
  const missingImpl = [...declared].filter((id) => !implemented.has(id));
  const missingDecl = [...implemented].filter((id) => !declared.has(id));
  const dup = registry.rules.map((r) => r.id).filter((id, i, a) => a.indexOf(id) !== i);
  const errors: string[] = [];
  if (missingImpl.length) errors.push(`declared in rules.yaml with no implementation: ${missingImpl.join(', ')}`);
  if (missingDecl.length) errors.push(`implemented with no row in rules.yaml: ${missingDecl.join(', ')}`);
  if (dup.length) errors.push(`declared twice in rules.yaml: ${[...new Set(dup)].join(', ')}`);
  for (const r of registry.rules) {
    if (r.severity !== 'block' && r.severity !== 'warn') errors.push(`rule ${r.id}: severity must be block or warn`);
    if (!r.message) errors.push(`rule ${r.id}: no message`);
  }
  if (errors.length) throw new Error(`rules registry incomplete: ${errors.join('; ')}`);
}

/** Every finding for a tree, blockers first, then in registry order. */
export function evaluate(tree: ProgramTree, registry: RuleRegistry): Finding[] {
  const out: Finding[] = [];
  for (const rule of registry.rules) {
    if (rule.applies_to_kinds && !rule.applies_to_kinds.includes(tree.kind)) continue;
    const impl = RULE_IMPLEMENTATIONS[rule.id];
    if (!impl) continue;           // assertRegistryComplete has already refused this at load
    out.push(...impl(tree, rule));
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1));
}

export function hasBlockers(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'block');
}
