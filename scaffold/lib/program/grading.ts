import 'server-only';
import { query, queryOne, transaction } from '@/lib/db';
import { can, type ResolvedAccess } from '@/lib/access';
import { gradeScale, gradeTokens, nonScoringCode } from '@/lib/config';
import { loadProgramVersion } from '@/lib/program';
import { instructorProjection } from '@/lib/program/projection';
import type { CompetencyGradeMode, TaskOutcomeMode } from '@/lib/program/shape';
import {
  competencyGradeText, competencyGradeValue, latestAttempts, proposeCompetencyGrade,
  taskGradeText, taskGradeValue, GradeRejected,
  type CompetencyValue, type GradeVocabulary, type Proposal, type TaskValue,
} from './grade-tokens';
import { judgeStoredOutcome } from './outcome-standard';

/**
 * lib/program/grading.ts - the write path behind the grading surface. docs/04_ETR.md §3.
 *
 * One click, one write. The surface holds no unsaved work: every grade, behaviour selection and
 * remark reaches this module as it is made, so closing a laptop mid-session loses nothing and the
 * page never has to ask "save before leaving?". What makes that safe is that all of it is an UPSERT
 * on the row's natural key - a second click on the same grade is the same row, not a duplicate.
 *
 * THE SURFACE IS NOT THE AUTHORITY. Three things are re-derived here from the database on every
 * write and are never taken from the request:
 *
 *   - the GRADING PLAN. Which elements are graded, on which scale, and which competencies each one
 *     targets comes from the published version behind the session (`gradingPlan`). A client that
 *     asks to grade an element the program does not grade, or on a scale it does not use, is
 *     refused - otherwise the form would be the schema.
 *   - the ATTEMPT. `nextAttempt` reads max(attempt) + 1. A client that sends an attempt number can
 *     overwrite the first attempt, which is exactly the data migration 0026 exists to protect.
 *   - the LOCK. The FIRST signature by either party freezes the session (`gradingGate`). It is
 *     checked in the handler, not by hiding a button: the surface stays mounted after a signature
 *     and simply reads as locked, and an API caller meets the same refusal.
 *
 * SECTION NOTES are stored as an element_grades row for the SECTION's key, with no grade and the
 * text in `remark`. element_key deliberately carries no foreign key (0026), so a section is as
 * addressable as an exercise; the row has no grade, so it is `empty` to lib/grades.ts and enters no
 * distribution. It freezes into record_tasks with everything else and needs no second table.
 */

export class GradeRefused extends Error {}

/** The operator's grade vocabulary, assembled from the two config files. */
export function gradingVocabulary(): GradeVocabulary {
  const scale = gradeScale();
  return {
    scale,
    taskPassFail: gradeTokens('task_pass_fail'),
    competencyBinary: gradeTokens('competency_binary'),
    notObserved: nonScoringCode('not_observed', scale),
  };
}

/* ------------------------------------------------------------------ the gate */

export interface SessionGate {
  readonly sessionId: string;
  readonly templateVersionId: string;
  readonly frameworkId: string | null;
  readonly status: string;
  readonly assessorPersonId: string | null;
  readonly secondAssessorPersonId: string | null;
  /** True once anybody has signed, or the session is no longer editable. */
  readonly locked: boolean;
  /** What to tell the instructor. Null when the session is open. */
  readonly lockReason: string | null;
}

interface GateRow {
  id: string; template_version_id: string; framework_id: string | null; status: string;
  assessor_person_id: string | null; second_assessor_person_id: string | null;
  assessor_signed_at: string | null; subject_signed_count: number;
}

/**
 * Reads the session and decides whether this caller may write to it.
 *
 * `training.sessions.grade` is the capability; holding it is not enough. The assessor of record (or
 * the second assessor) is who grades - a capability says what kind of work you do, the session says
 * whose work this is. `training.records.amend` is the documented way in for anybody else, and it is
 * a different, audited act.
 */
export async function gradingGate(sessionId: string, access: ResolvedAccess, personId: string | null): Promise<SessionGate> {
  const row = await queryOne<GateRow>(
    `SELECT s.id, s.template_version_id, s.framework_id::text AS framework_id, s.status,
            s.assessor_person_id::text AS assessor_person_id, s.second_assessor_person_id::text AS second_assessor_person_id,
            s.assessor_signed_at::text AS assessor_signed_at,
            (SELECT count(*)::int FROM session_subjects ss WHERE ss.session_id = s.id AND ss.subject_signed_at IS NOT NULL) AS subject_signed_count
       FROM sessions s
      WHERE s.id = $1::uuid AND s.deleted_at IS NULL`,
    [sessionId],
  );
  if (!row) throw new GradeRefused('not_found');

  if (!can(access, 'training.sessions.grade')) throw new GradeRefused('Your account may not grade a session.');
  const mine = personId !== null && (personId === row.assessor_person_id || personId === row.second_assessor_person_id);
  if (!mine && !can(access, 'training.records.amend')) {
    throw new GradeRefused('Only the instructor named on this session can grade it.');
  }

  const signed = row.assessor_signed_at !== null || row.subject_signed_count > 0;
  const closed = row.status === 'finalized' || row.status === 'void';
  const lockReason = closed
    ? row.status === 'void' ? 'This session is void.' : 'This session is finalised; the record is frozen.'
    : signed
      ? 'A signature locked this session. It has to be unsigned before anything changes.'
      : null;

  return {
    sessionId: row.id,
    templateVersionId: row.template_version_id,
    frameworkId: row.framework_id,
    status: row.status,
    assessorPersonId: row.assessor_person_id,
    secondAssessorPersonId: row.second_assessor_person_id,
    locked: lockReason !== null,
    lockReason,
  };
}

/** The gate, refusing a write when the session is locked. Reads may pass a locked gate. */
export function assertWritable(gate: SessionGate): void {
  if (gate.locked) throw new GradeRefused(gate.lockReason ?? 'This session is locked.');
}

/* ------------------------------------------------------------------ the plan */

export interface PlannedTask {
  readonly title: string;
  readonly mode: TaskOutcomeMode;
  /** Framework competency codes this element targets. */
  readonly targets: readonly string[];
}

export interface GradingPlan {
  /** Graded exercises by element key. A key that is not here is not graded by this program. */
  readonly tasks: Map<string, PlannedTask>;
  /** How each targeted competency is graded. */
  readonly competencyModes: Map<string, CompetencyGradeMode>;
  /** Section keys, so a section note is only accepted for a real section. */
  readonly sections: Set<string>;
}

/**
 * The published program's own statement of what may be graded. Derived from the version content
 * through the same projection the surface renders, so the two cannot disagree.
 */
export async function gradingPlan(templateVersionId: string): Promise<GradingPlan> {
  const program = await loadProgramVersion(templateVersionId);
  const tasks = new Map<string, PlannedTask>();
  const competencyModes = new Map<string, CompetencyGradeMode>();
  const sections = new Set<string>();
  if (!program) return { tasks, competencyModes, sections };

  for (const section of instructorProjection(program.tree, { runtime: null }).sections) {
    sections.add(section.key);
    for (const step of section.steps) {
      if (step.kind !== 'exercise') continue;
      const g = step.grading;
      if (g.task_outcome_mode !== 'none' || g.competency_grade_mode !== 'none') {
        tasks.set(step.key, { title: step.title, mode: g.task_outcome_mode, targets: g.competencies });
      }
      if (g.competency_grade_mode !== 'none') {
        for (const code of g.competencies) {
          if ((competencyModes.get(code) ?? 'none') === 'none') competencyModes.set(code, g.competency_grade_mode);
        }
      }
    }
  }
  return { tasks, competencyModes, sections };
}

/* ------------------------------------------------------------------ reading back */

export interface StoredTask { readonly elementKey: string; readonly attempt: number; readonly grade: string | null; readonly remark: string | null; readonly seat: string | null }
export interface StoredCompetency { readonly code: string; readonly grade: string | null; readonly remark: string | null; readonly obs: string[]; readonly proposedGrade: string | null }

export interface StoredGrading {
  readonly tasks: StoredTask[];
  readonly competencies: StoredCompetency[];
  readonly outcome: string | null;
  readonly remarks: string | null;
  /** The session clock, from sessions.setup. Null when the instructor has not started it. */
  readonly startedAt: string | null;
}

/**
 * Everything already written for one pilot in one session, in the shape the surface hydrates from.
 * Every attempt is returned, not the last one: the surface shows a repeat beside the first attempt
 * because that is what the instructor did.
 */
export async function loadSubjectGrading(sessionId: string, personId: string): Promise<StoredGrading> {
  const [tasks, comps, session] = await Promise.all([
    query<StoredTask>(
      `SELECT element_key AS "elementKey", attempt, grade, remark, value_text AS seat
         FROM element_grades
        WHERE session_id = $1::uuid AND person_id = $2::uuid AND instance_no = 1
        ORDER BY element_key, attempt`,
      [sessionId, personId],
    ),
    query<StoredCompetency>(
      `SELECT c.code, cg.grade, cg.remark, cg.proposed_grade AS "proposedGrade",
              COALESCE((SELECT array_agg(ob.code ORDER BY ob.code)
                          FROM competency_grade_obs x JOIN observable_behaviours ob ON ob.id = x.observable_behaviour_id
                         WHERE x.competency_grade_id = cg.id), '{}') AS obs
         FROM competency_grades cg JOIN competencies c ON c.id = cg.competency_id
        WHERE cg.session_id = $1::uuid AND cg.person_id = $2::uuid
        ORDER BY c.position, c.code`,
      [sessionId, personId],
    ),
    queryOne<{ outcome: string | null; remarks: string | null; started_at: string | null }>(
      `SELECT ss.outcome, s.remarks, s.setup->>'started_at' AS started_at FROM sessions s
         LEFT JOIN session_subjects ss ON ss.session_id = s.id AND ss.person_id = $2::uuid
        WHERE s.id = $1::uuid`,
      [sessionId, personId],
    ),
  ]);
  return { tasks, competencies: comps, outcome: session?.outcome ?? null, remarks: session?.remarks ?? null, startedAt: session?.started_at ?? null };
}

/* ------------------------------------------------------------------ writes */

export interface TaskWrite {
  readonly sessionId: string;
  readonly personId: string;
  readonly elementKey: string;
  readonly attempt?: number;
  readonly value?: TaskValue;
  readonly remark?: string | null;
  /**
   * Which seat the pilot flew this exercise in, when the element counts one. It goes in `value_text`,
   * not in `grade`: migration 0034 separates the answers an assessor RECORDED from the judgements
   * they MADE, precisely so that a seat never turns up in a grade distribution.
   */
  readonly seat?: string | null;
  readonly userId: string;
}

export interface TaskSaved { readonly savedAt: string; readonly attempt: number; readonly grade: string | null }

/**
 * One task grade, one remark, or both. The attempt defaults to the one already open (the highest
 * there is, or 1): a grade the instructor corrects is the same attempt, and a genuine repeat is
 * `startAttempt` below, which is a deliberate act with its own button.
 */
export async function saveTaskGrade(w: TaskWrite, plan: GradingPlan, v: GradeVocabulary): Promise<TaskSaved> {
  const planned = plan.tasks.get(w.elementKey);
  if (!planned && !plan.sections.has(w.elementKey)) throw new GradeRefused(`This program does not grade ${w.elementKey}.`);

  let grade: string | null | undefined;
  if (w.value !== undefined) {
    if (!planned) throw new GradeRefused('A section comment carries no grade.');
    try {
      grade = taskGradeText(planned.mode, w.value, v);
    } catch (e) {
      throw e instanceof GradeRejected ? new GradeRefused(e.message) : e;
    }
  }

  const attempt = w.attempt ?? (await currentAttempt(w.sessionId, w.personId, w.elementKey));
  const sets: string[] = ['graded_at = now()', 'graded_by = EXCLUDED.graded_by'];
  if (grade !== undefined) sets.push('grade = EXCLUDED.grade');
  if (w.remark !== undefined) sets.push('remark = EXCLUDED.remark');
  if (w.seat !== undefined) sets.push('value_text = EXCLUDED.value_text');

  const row = await queryOne<{ graded_at: string; grade: string | null }>(
    `INSERT INTO element_grades (session_id, person_id, element_key, instance_no, attempt, grade, remark, value_text, graded_by)
     VALUES ($1::uuid, $2::uuid, $3, 1, $4, $5, $6, $7, $8::uuid)
     ON CONFLICT (session_id, person_id, element_key, instance_no, attempt)
     DO UPDATE SET ${sets.join(', ')}
     RETURNING graded_at::text AS graded_at, grade`,
    [w.sessionId, w.personId, w.elementKey, attempt, grade ?? null, w.remark ?? null, w.seat ?? null, w.userId],
  );
  return { savedAt: row?.graded_at ?? new Date().toISOString(), attempt, grade: row?.grade ?? null };
}

/** The attempt currently being graded: the highest row there is, or 1 when there is none. */
export async function currentAttempt(sessionId: string, personId: string, elementKey: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COALESCE(max(attempt), 1)::int AS n FROM element_grades
      WHERE session_id = $1::uuid AND person_id = $2::uuid AND element_key = $3 AND instance_no = 1`,
    [sessionId, personId, elementKey],
  );
  return row?.n ?? 1;
}

/**
 * Opens the next attempt at one task: a NEW ROW, never an edit of the last one. The first attempt
 * stays exactly as it was graded, which is the whole point - a task graded 2 then 4 must not read
 * as "meets standard" (migration 0026).
 */
export async function startAttempt(sessionId: string, personId: string, elementKey: string, userId: string, plan: GradingPlan): Promise<number> {
  if (!plan.tasks.has(elementKey)) throw new GradeRefused(`This program does not grade ${elementKey}.`);
  const row = await queryOne<{ attempt: number }>(
    `INSERT INTO element_grades (session_id, person_id, element_key, instance_no, attempt, graded_by)
     SELECT $1::uuid, $2::uuid, $3, 1, COALESCE(max(attempt), 0) + 1, $4::uuid
       FROM element_grades
      WHERE session_id = $1::uuid AND person_id = $2::uuid AND element_key = $3 AND instance_no = 1
     RETURNING attempt`,
    [sessionId, personId, elementKey, userId],
  );
  if (!row) throw new GradeRefused('The repeat could not be opened.');
  return row.attempt;
}

export interface CompetencyWrite {
  readonly sessionId: string;
  readonly personId: string;
  readonly frameworkId: string;
  readonly code: string;
  readonly value?: CompetencyValue;
  readonly remark?: string | null;
  /** Observable-behaviour codes, as the complete selection. Absent leaves the selection alone. */
  readonly obs?: readonly string[];
  readonly userId: string;
}

export interface CompetencySaved { readonly savedAt: string; readonly grade: string | null; readonly proposal: Proposal }

/**
 * One competency grade, its remark and its selected behaviours, with the PROPOSED grade recomputed
 * from the task evidence as it stands and stored beside the instructor's own (migration 0149).
 *
 * The proposal is written on the same row and in the same transaction as the grade, so the pair is
 * always the pair the instructor saw. It is never written over `grade`, and an existing proposal is
 * only replaced while the instructor is still grading this competency.
 */
export async function saveCompetencyGrade(w: CompetencyWrite, plan: GradingPlan, v: GradeVocabulary): Promise<CompetencySaved> {
  const mode = plan.competencyModes.get(w.code);
  if (!mode || mode === 'none') throw new GradeRefused(`This program does not grade ${w.code}.`);

  let grade: string | null | undefined;
  if (w.value !== undefined) {
    try {
      grade = competencyGradeText(mode, w.value, v);
    } catch (e) {
      throw e instanceof GradeRejected ? new GradeRefused(e.message) : e;
    }
  }

  const evidence = latestAttempts(
    (await query<{ elementKey: string; attempt: number; grade: string | null }>(
      `SELECT element_key AS "elementKey", attempt, grade FROM element_grades
        WHERE session_id = $1::uuid AND person_id = $2::uuid AND instance_no = 1`,
      [w.sessionId, w.personId],
    )).map((r) => ({ ...r, targets: plan.tasks.get(r.elementKey)?.targets ?? [] })),
  );
  const proposal = proposeCompetencyGrade(w.code, mode, evidence, v, w.obs?.length ?? 0);

  return transaction(async (client) => {
    const comp = await client.query<{ id: string }>(
      `SELECT id FROM competencies WHERE framework_id = $1::uuid AND code = $2 AND is_active`, [w.frameworkId, w.code],
    );
    const competencyId = comp.rows[0]?.id;
    if (!competencyId) throw new GradeRefused(`${w.code} is not a competency of this framework.`);

    const sets = ['graded_at = now()', 'graded_by = EXCLUDED.graded_by', 'proposed_grade = EXCLUDED.proposed_grade',
      'proposed_at = EXCLUDED.proposed_at', 'proposed_basis = EXCLUDED.proposed_basis'];
    if (grade !== undefined) sets.push('grade = EXCLUDED.grade');
    if (w.remark !== undefined) sets.push('remark = EXCLUDED.remark');

    const saved = await client.query<{ id: string; graded_at: string; grade: string | null }>(
      `INSERT INTO competency_grades (session_id, person_id, framework_id, competency_id, grade, remark, graded_by, proposed_grade, proposed_at, proposed_basis)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, $8, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, $9::jsonb)
       ON CONFLICT (session_id, person_id, competency_id)
       DO UPDATE SET ${sets.join(', ')}
       RETURNING id, graded_at::text AS graded_at, grade`,
      [w.sessionId, w.personId, w.frameworkId, competencyId, grade ?? null, w.remark ?? null, w.userId, proposal.grade, JSON.stringify(proposal.basis)],
    );
    const row = saved.rows[0];
    if (!row) throw new GradeRefused('The grade could not be saved.');

    // The behaviours are a SET, so a selection is replaced wholesale rather than diffed: the
    // surface always knows the complete selection, and a diff would need an ordering it has not got.
    if (w.obs !== undefined) {
      await client.query(`DELETE FROM competency_grade_obs WHERE competency_grade_id = $1::uuid`, [row.id]);
      if (w.obs.length > 0) {
        await client.query(
          `INSERT INTO competency_grade_obs (competency_grade_id, observable_behaviour_id)
           SELECT $1::uuid, ob.id FROM observable_behaviours ob
            WHERE ob.framework_id = $2::uuid AND ob.competency_id = $3::uuid AND ob.code = ANY($4::text[]) AND ob.is_active
           ON CONFLICT DO NOTHING`,
          [row.id, w.frameworkId, competencyId, [...w.obs]],
        );
      }
    }
    return { savedAt: row.graded_at, grade: row.grade, proposal };
  });
}

export interface SessionWrite {
  readonly sessionId: string;
  readonly personId: string;
  readonly outcome?: string | null;
  readonly remarks?: string | null;
  /**
   * When the session clock was started, ISO, or null to stop it. It lives in `sessions.setup`
   * rather than in a column of its own: `setup` is where the session's own conditions already go,
   * and the clock is one of them. Not `created_at` - a session is created before it is flown, and
   * often on another day.
   */
  readonly startedAt?: string | null;
}

/**
 * The pilot's outcome and the session remarks. The outcome is the ASSESSOR'S word and is never
 * computed here - `outcome_is_always_explicit` - but it is now checked against the operator's
 * standard before it is stored. Two separate refusals, and they are not the same thing:
 *
 *   - the VOCABULARY check: is this a word this operator records at all?
 *   - the STANDARD check: may THESE grades be recorded as a pass? lib/program/outcome-standard.ts.
 *
 * The standard is checked here, on the write, so the instructor meets it with the grades still in
 * front of them rather than at the signature with the session behind them. It is checked again in
 * signing.ts, because a rule the surface enforces is not a rule.
 */
export async function saveSessionFields(w: SessionWrite, outcomes: readonly string[]): Promise<{ savedAt: string }> {
  if (w.outcome !== undefined && w.outcome !== null && w.outcome !== '' && !outcomes.includes(w.outcome)) {
    throw new GradeRefused(`${w.outcome} is not an outcome this operator records.`);
  }
  if (w.outcome !== undefined && w.outcome !== null && w.outcome !== '') {
    const verdict = await judgeStoredOutcome(w.sessionId, w.personId, w.outcome);
    if (!verdict.allowed) throw new GradeRefused(verdict.reason ?? `${w.outcome} cannot be recorded against these grades.`);
  }
  if (w.outcome !== undefined) {
    await query(
      `UPDATE session_subjects SET outcome = NULLIF($3, '') WHERE session_id = $1::uuid AND person_id = $2::uuid`,
      [w.sessionId, w.personId, w.outcome ?? ''],
    );
  }
  if (w.remarks !== undefined) {
    await query(`UPDATE sessions SET remarks = NULLIF($2, '') WHERE id = $1::uuid`, [w.sessionId, w.remarks ?? '']);
  }
  if (w.startedAt !== undefined) {
    let iso: string | null = null;
    if (w.startedAt !== null && w.startedAt !== '') {
      const when = new Date(w.startedAt);
      if (Number.isNaN(when.getTime())) throw new GradeRefused('That start time could not be read.');
      iso = when.toISOString();
    }
    await query(
      iso === null
        ? `UPDATE sessions SET setup = COALESCE(setup, '{}'::jsonb) - 'started_at' WHERE id = $1::uuid`
        : `UPDATE sessions SET setup = jsonb_set(COALESCE(setup, '{}'::jsonb), '{started_at}', to_jsonb($2::text), true) WHERE id = $1::uuid`,
      iso === null ? [w.sessionId] : [w.sessionId, iso],
    );
  }
  return { savedAt: new Date().toISOString() };
}

/** Read one stored task grade back into the surface's union type. */
export function readTask(mode: TaskOutcomeMode, grade: string | null, v: GradeVocabulary): TaskValue {
  return taskGradeValue(mode, grade, v);
}
/** Read one stored competency grade back into the surface's union type. */
export function readCompetency(mode: CompetencyGradeMode, grade: string | null, v: GradeVocabulary): CompetencyValue {
  return competencyGradeValue(mode, grade, v);
}
