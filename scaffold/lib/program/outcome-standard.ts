import 'server-only';
import { query } from '@/lib/db';
import { gradeScale, policy, type PolicyConfig } from '@/lib/config';
import { gradeNum } from '@/lib/analytics/grade-sql';

/**
 * lib/program/outcome-standard.ts - the one rule in this platform that overrules an instructor.
 *
 * WHAT IT DOES AND WHAT IT DELIBERATELY DOES NOT. It decides whether a set of competency grades may
 * be RECORDED AS A PASS. It never touches a grade, never proposes one, and never writes an outcome:
 * `policy.yaml grading.outcome_is_always_explicit` still holds, and the instructor still decides
 * what each competency earned. The operator has drawn a line at which a set of grades stops adding
 * up to a pass, and this is that line.
 *
 * It exists because the operator asked for it, against the kit's own earlier position - which is
 * why `policy.yaml grading.remedial_is_advisory` was changed to false in the same commit rather than
 * left saying one thing while this file did another. Set it back to true and the intent is a
 * warning again; this module is the only thing that would need to change.
 *
 * THE TWO THRESHOLDS, both from analytics.yaml `grade_scale`:
 *   critical_grade                  - one of these refuses a pass on its own. Non-compensatory.
 *   outcome_standard.refuse_pass_at - this many grades of exactly `refuse_pass_grade` refuse one.
 *
 * WHY IT IS ENFORCED ON THE WRITE and again at the SIGNATURE. On the write, so the instructor meets
 * the rule while the grades are in front of them and can change a grade or the outcome there and
 * then. At the signature, because a rule enforced only by the surface is not a rule: an API caller,
 * a stale tab or a replayed request all reach the same refusal. Neither check is redundant; they
 * answer different questions.
 *
 * PARTIAL PASS IS NOT A PASS HERE, and is not a fail either. policy.yaml says in as many words that
 * it is never folded into either side and that a surface needing a pass/fail reading must ask rather
 * than assume - so this rule leaves it alone. Only PASS and whatever the operator maps to PASS
 * (PROFICIENT, in EBT vocabulary) are refused.
 */

export interface OutcomeCounts {
  /** Competency grades at exactly `refuse_pass_grade`. */
  readonly atRefuseGrade: number;
  /** Competency grades at `critical_grade`. */
  readonly critical: number;
}

export interface OutcomeVerdict {
  readonly allowed: boolean;
  /** One sentence naming what was counted and against which threshold. Null when allowed. */
  readonly reason: string | null;
  readonly counts: OutcomeCounts;
}

/** The outcomes that READ as a pass: 'PASS' plus anything the operator maps to it. */
export function passOutcomes(p: PolicyConfig = policy()): string[] {
  const eq = p.grading?.outcome_equivalents ?? {};
  const mapped = Object.entries(eq).filter(([, v]) => String(v).toUpperCase() === 'PASS').map(([k]) => k);
  return [...new Set(['PASS', ...mapped])];
}

export function isPassOutcome(outcome: string | null | undefined, p: PolicyConfig = policy()): boolean {
  if (!outcome) return false;
  const want = outcome.trim().toUpperCase();
  return passOutcomes(p).some((o) => o.toUpperCase() === want);
}

/** The competency grades already written for one pilot in one session, counted against the two thresholds. */
export async function outcomeCounts(sessionId: string, personId: string): Promise<OutcomeCounts> {
  const scale = gradeScale();
  const refuseGrade = scale.outcome_standard?.refuse_pass_grade ?? scale.below_standard_max;
  const rows = await query<{ at_refuse: string; critical: string }>(
    `SELECT count(*) FILTER (WHERE ${gradeNum('cg.grade')} = $3)::text AS at_refuse,
            count(*) FILTER (WHERE ${gradeNum('cg.grade')} = $4)::text AS critical
       FROM competency_grades cg
      WHERE cg.session_id = $1::uuid AND cg.person_id = $2::uuid`,
    [sessionId, personId, refuseGrade, scale.critical_grade],
  );
  return { atRefuseGrade: Number(rows[0]?.at_refuse ?? 0), critical: Number(rows[0]?.critical ?? 0) };
}

/**
 * The judgement itself, separated from the query so it can be read, tested and explained without a
 * database. `outcome` is what the instructor is trying to record.
 */
export function judgeOutcome(outcome: string | null | undefined, counts: OutcomeCounts, p: PolicyConfig = policy()): OutcomeVerdict {
  const scale = gradeScale();
  const std = scale.outcome_standard;
  if (!isPassOutcome(outcome, p)) return { allowed: true, reason: null, counts };

  if (counts.critical > 0) {
    const n = counts.critical;
    return {
      allowed: false,
      counts,
      reason: `${n} ${n === 1 ? 'competency is' : 'competencies are'} graded ${scale.critical_grade}. A grade of ${scale.critical_grade} cannot be compensated by the others, so this record cannot carry ${outcome}.`,
    };
  }
  if (std && counts.atRefuseGrade >= std.refuse_pass_at) {
    return {
      allowed: false,
      counts,
      reason: `${counts.atRefuseGrade} competencies are graded ${std.refuse_pass_grade}, and this operator's standard refuses ${outcome} at ${std.refuse_pass_at}. Change a grade, or record an outcome that is not a pass.`,
    };
  }
  return { allowed: true, reason: null, counts };
}

/** The whole check in one call, for a caller that has a session and a pilot. */
export async function judgeStoredOutcome(sessionId: string, personId: string, outcome: string | null | undefined): Promise<OutcomeVerdict> {
  return judgeOutcome(outcome, await outcomeCounts(sessionId, personId));
}
