/**
 * grade-tokens.ts - what a grading surface's value IS in the database, and the proposed competency
 * grade. Pure, client-safe, no database and no config read of its own: the vocabulary is INJECTED,
 * exactly as lib/grades.ts takes the grade scale.
 *
 * Three grading modes exist (lib/program/shape.ts): a task is `pass_fail` or `scale_1_5`, a
 * competency is `scale_1_5` or `competent_not_competent`. The columns behind them are TEXT with no
 * CHECK (migrations 0026, 0027), deliberately - the vocabulary is configuration. So the surface
 * works in a small union type and this module is the ONLY place that turns that union into stored
 * text and back. Nothing else writes 'PASS', 'C' or 'NO' into a grade column.
 *
 * THE PROPOSED COMPETENCY GRADE. `proposeCompetencyGrade` reads the task grades of the exercises
 * that target a competency and proposes what that evidence adds up to. It is advisory in exactly
 * the sense policy.yaml means it: `grading.outcome_is_always_explicit` for the outcome, and the
 * same principle one level down - the instructor's grade is the record, the proposal sits beside it
 * so that a divergence is visible rather than lost. Two rules make it defensible:
 *
 *   - a critical grade is NOT averaged away. One task at `grade_scale.critical_grade` proposes that
 *     grade for the competency, because the scale defines it as non-compensatory.
 *   - ties round DOWN. A mean of 3.5 proposes 3. The proposal never rounds in the pilot's favour;
 *     an instructor who believes the higher grade is right enters it and their reason, which is the
 *     conversation the surface is there to have.
 *
 * Observable behaviours are NOT an input to the grade. They are selected, not graded (0027), so a
 * count of them says how well the grade was evidenced, never what the grade should be; the count
 * travels in the basis so the surface can say "3 proposed on 4 tasks, 2 behaviours recorded".
 */

// Relative, not aliased: vitest.config.ts resolves no path alias, and this module is unit-tested.
import { isScored, gradeNum, type GradeScaleConfig, type RawGrade } from '../grades';
import type { TaskOutcomeMode, CompetencyGradeMode } from './shape';

/** Everything this module needs to know about the operator's grade vocabulary. */
export interface GradeVocabulary {
  readonly scale: GradeScaleConfig;
  /** policy.yaml grading.task_pass_fail_values, [meets standard, below standard]. */
  readonly taskPassFail: readonly [string, string];
  /** policy.yaml grading.competency_binary_values, [competent, not competent]. */
  readonly competencyBinary: readonly [string, string];
  /** The non-scoring code that means not observed (analytics.yaml grade_scale.code_meanings). */
  readonly notObserved: string;
}

/** What the surface holds for one task. `null` is "not graded yet", never a zero. */
export type TaskValue = number | 'pass' | 'fail' | null;
/** What the surface holds for one competency. */
export type CompetencyValue = number | 'competent' | 'not_competent' | 'not_observed' | null;

export class GradeRejected extends Error {}

function numeric(value: number, scale: GradeScaleConfig): string {
  if (!Number.isInteger(value) || value < scale.min || value > scale.max) {
    throw new GradeRejected(`${value} is not a grade on this scale (${scale.min}-${scale.max}).`);
  }
  return String(value);
}

/** The text to store for one task value, or null to clear the grade. */
export function taskGradeText(mode: TaskOutcomeMode, value: TaskValue, v: GradeVocabulary): string | null {
  if (value === null) return null;
  if (mode === 'none') throw new GradeRejected('This task is not graded.');
  if (mode === 'scale_1_5') {
    if (typeof value !== 'number') throw new GradeRejected('This task is graded on the scale, not pass / fail.');
    return numeric(value, v.scale);
  }
  if (typeof value === 'number') throw new GradeRejected('This task is graded pass / fail, not on the scale.');
  return value === 'pass' ? v.taskPassFail[0] : v.taskPassFail[1];
}

/** The stored text read back as a task value. Anything unrecognised reads as not graded. */
export function taskGradeValue(mode: TaskOutcomeMode, text: RawGrade, v: GradeVocabulary): TaskValue {
  const raw = text === null || text === undefined ? '' : String(text).trim();
  if (raw === '') return null;
  if (mode === 'pass_fail') {
    if (raw.toUpperCase() === v.taskPassFail[0].toUpperCase()) return 'pass';
    if (raw.toUpperCase() === v.taskPassFail[1].toUpperCase()) return 'fail';
    return null;
  }
  return gradeNum(raw, v.scale);
}

/** The text to store for one competency value, or null to clear it. */
export function competencyGradeText(mode: CompetencyGradeMode, value: CompetencyValue, v: GradeVocabulary): string | null {
  if (value === null) return null;
  if (mode === 'none') throw new GradeRejected('This competency is not graded here.');
  if (value === 'not_observed') return v.notObserved;
  if (mode === 'scale_1_5') {
    if (typeof value !== 'number') throw new GradeRejected('This competency is graded on the scale.');
    return numeric(value, v.scale);
  }
  if (typeof value === 'number') throw new GradeRejected('This competency is graded competent / not competent.');
  return value === 'competent' ? v.competencyBinary[0] : v.competencyBinary[1];
}

/** The stored text read back as a competency value. */
export function competencyGradeValue(mode: CompetencyGradeMode, text: RawGrade, v: GradeVocabulary): CompetencyValue {
  const raw = text === null || text === undefined ? '' : String(text).trim();
  if (raw === '') return null;
  const upper = raw.toUpperCase();
  if (upper === v.notObserved.toUpperCase()) return 'not_observed';
  if (mode === 'competent_not_competent') {
    if (upper === v.competencyBinary[0].toUpperCase()) return 'competent';
    if (upper === v.competencyBinary[1].toUpperCase()) return 'not_competent';
    return null;
  }
  return gradeNum(raw, v.scale);
}

/* ------------------------------------------------------------------ the proposal */

/** One task's contribution: its stored grade and the competencies its element targets. */
export interface TaskEvidence {
  readonly elementKey: string;
  readonly grade: RawGrade;
  readonly targets: readonly string[];
}

/** Why the proposal is what it is. Stored as JSONB beside it, and rendered on the surface. */
export interface ProposalBasis {
  readonly n_scored: number;
  readonly mean: number | null;
  /** True when a critical grade set the proposal on its own. */
  readonly critical: boolean;
  readonly from: readonly string[];
  readonly obs_selected: number;
}

export interface Proposal {
  /** The stored text to keep in `competency_grades.proposed_grade`, or null when nothing scored. */
  readonly grade: string | null;
  /** The same value in the surface's union, for rendering beside the instructor's own. */
  readonly value: CompetencyValue;
  readonly basis: ProposalBasis;
}

/**
 * Keeps only the highest attempt of each element, which is what a proposal reads: the attempt the
 * instructor settled on. Every attempt stays in the table and every attempt reaches the analytics -
 * see the comment in migration 0026 - but proposing a grade from a superseded first attempt would
 * argue against evidence the instructor has already revised.
 */
export function latestAttempts<T extends { readonly elementKey: string; readonly attempt: number }>(rows: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const seen = best.get(r.elementKey);
    if (!seen || r.attempt > seen.attempt) best.set(r.elementKey, r);
  }
  return [...best.values()];
}

/**
 * The proposed grade for one competency, from the tasks that target it.
 *
 * Returns a null grade - not a default, not a mid-scale value - when nothing that targets the
 * competency has a scored grade. A proposal with no evidence behind it is worse than none: the
 * instructor would be arguing with an average of zero observations.
 */
export function proposeCompetencyGrade(
  competencyCode: string,
  mode: CompetencyGradeMode,
  tasks: readonly TaskEvidence[],
  v: GradeVocabulary,
  obsSelected = 0,
): Proposal {
  const mine = tasks.filter((t) => t.targets.includes(competencyCode));
  const scored = mine.filter((t) => isScored(t.grade, v.scale));
  const values = scored.map((t) => gradeNum(t.grade, v.scale) as number);
  const from = scored.map((t) => t.elementKey);

  if (values.length === 0 || mode === 'none') {
    return { grade: null, value: null, basis: { n_scored: 0, mean: null, critical: false, from: [], obs_selected: obsSelected } };
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const critical = values.includes(v.scale.critical_grade);
  // Ties round down: -Math.round(-x) rounds .5 toward the lower integer, where Math.round does not.
  const rounded = critical ? v.scale.critical_grade : Math.min(v.scale.max, Math.max(v.scale.min, -Math.round(-mean)));
  const basis: ProposalBasis = { n_scored: values.length, mean, critical, from, obs_selected: obsSelected };

  if (mode === 'competent_not_competent') {
    const value: CompetencyValue = rounded <= v.scale.below_standard_max ? 'not_competent' : 'competent';
    return { grade: competencyGradeText(mode, value, v), value, basis };
  }
  return { grade: competencyGradeText(mode, rounded, v), value: rounded, basis };
}
