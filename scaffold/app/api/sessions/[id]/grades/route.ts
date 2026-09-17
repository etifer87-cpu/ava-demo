import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { resolveAccess, canOnPerson } from '@/lib/access';
import { policy } from '@/lib/config';
import { audit, actorFromSession, requestContext, AUDIT_ACTIONS } from '@/lib/audit';
import {
  assertWritable, gradingGate, gradingPlan, gradingVocabulary, loadSubjectGrading,
  saveCompetencyGrade, saveSessionFields, saveTaskGrade, startAttempt, GradeRefused,
} from '@/lib/program/grading';

/**
 * /api/sessions/[id]/grades - the grading surface's only write path.
 *
 * GET returns everything already stored for one pilot, which is what the surface hydrates from on a
 * reload. POST takes ONE change and applies it, because that is how grading happens: a grade is a
 * click, a remark is a pause in typing, and neither should wait for a Save button that an instructor
 * can walk away from. `kind` says which:
 *
 *   task        one element grade, remark and / or seat       { element_key, value?, remark?, seat? }
 *   attempt     open the next attempt at one element         { element_key }
 *   competency  one competency grade, remark, behaviours     { code, value?, remark?, obs? }
 *   session     outcome, session remarks, the clock            { outcome?, remarks?, started_at? }
 *
 * Every POST re-reads the gate: the capability, whether this caller is the assessor of record, and
 * whether a signature has locked the session. Nothing here trusts the request about what may be
 * graded - lib/program/grading.ts re-derives that from the published version.
 *
 * WHAT IS AUDITED. Not every write. A grade row already carries `graded_by` and `graded_at`, so a
 * log line per click would only bury the acts a reviewer actually looks for. The audit rows here are
 * the three things the grade rows cannot say for themselves: a repeat attempt was opened, an outcome
 * was entered, and a competency was graded AGAINST the proposal. Never the grade value itself - that
 * is in the row, and the log is a trail of acts, not a second copy of the evidence.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

function refused(err: unknown): NextResponse {
  if (err instanceof GradeRefused) {
    if (err.message === 'not_found') return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: false, error: 'refused', message: err.message }, { status: 409 });
  }
  const status = (err as { status?: number }).status;
  if (status === 403) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  throw err;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const personId = request.nextUrl.searchParams.get('person') ?? '';
  if (!UUID.test(id) || !UUID.test(personId)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const session = await requireSession();
  const access = await resolveAccess(session);
  try {
    const gate = await gradingGate(id, access, session.personId ?? null);
    if (!(await canOnPerson(access, 'people.view', personId))) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    const stored = await loadSubjectGrading(id, personId);
    return NextResponse.json({ ok: true, locked: gate.locked, lock_reason: gate.lockReason, ...stored });
  } catch (err) {
    return refused(err);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const session = await requireSession();
  const access = await resolveAccess(session);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const kind = String(body.kind ?? '');
  const personId = String(body.person_id ?? '');
  if (!UUID.test(personId)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const text = (v: unknown, max = 4000): string | null => (v === null ? null : String(v).slice(0, max));
  const actor = actorFromSession(session);
  const ctx = requestContext(request.headers);

  try {
    const gate = await gradingGate(id, access, session.personId ?? null);
    if (!(await canOnPerson(access, 'people.view', personId))) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    assertWritable(gate);
    const plan = await gradingPlan(gate.templateVersionId);
    const v = gradingVocabulary();
    const userId = session.userId;

    switch (kind) {
      case 'task': {
        const elementKey = String(body.element_key ?? '').slice(0, 200);
        const seat = 'seat' in body ? text(body.seat, 20) : undefined;
        const saved = await saveTaskGrade({
          sessionId: id, personId, elementKey, userId,
          ...('value' in body ? { value: body.value as never } : {}),
          ...('remark' in body ? { remark: text(body.remark) } : {}),
          ...(seat !== undefined ? { seat } : {}),
        }, plan, v);
        return NextResponse.json({ ok: true, saved_at: saved.savedAt, attempt: saved.attempt, grade: saved.grade });
      }

      case 'attempt': {
        const elementKey = String(body.element_key ?? '').slice(0, 200);
        const attempt = await startAttempt(id, personId, elementKey, userId, plan);
        await audit({ action: AUDIT_ACTIONS.sessionGrade, entityTable: 'element_grades', entityId: id, capabilityCode: 'training.sessions.grade',
          details: { element_key: elementKey, attempt_opened: attempt, person_id: personId } }, actor, ctx);
        return NextResponse.json({ ok: true, attempt });
      }

      case 'competency': {
        if (!gate.frameworkId) throw new GradeRefused('This session carries no competency framework.');
        const code = String(body.code ?? '').slice(0, 40);
        const obs = Array.isArray(body.obs) ? body.obs.map((o) => String(o).slice(0, 40)).slice(0, 60) : undefined;
        const saved = await saveCompetencyGrade({
          sessionId: id, personId, frameworkId: gate.frameworkId, code, userId,
          ...('value' in body ? { value: body.value as never } : {}),
          ...('remark' in body ? { remark: text(body.remark) } : {}),
          ...(obs !== undefined ? { obs } : {}),
        }, plan, v);
        // Only a divergence is worth a line: agreeing with the proposal is the ordinary case.
        if (saved.proposal.grade !== null && saved.grade !== null && saved.grade !== saved.proposal.grade) {
          await audit({ action: AUDIT_ACTIONS.sessionGrade, entityTable: 'competency_grades', entityId: id, capabilityCode: 'training.sessions.grade',
            details: { competency: code, person_id: personId, proposed: saved.proposal.grade, entered: saved.grade } }, actor, ctx);
        }
        return NextResponse.json({ ok: true, saved_at: saved.savedAt, grade: saved.grade, proposed: saved.proposal.grade, proposed_value: saved.proposal.value, basis: saved.proposal.basis });
      }

      case 'session': {
        const saved = await saveSessionFields({
          sessionId: id, personId,
          ...('outcome' in body ? { outcome: text(body.outcome, 40) } : {}),
          ...('remarks' in body ? { remarks: text(body.remarks) } : {}),
          ...('started_at' in body ? { startedAt: text(body.started_at, 40) } : {}),
        }, policy().grading?.outcomes ?? []);
        if ('outcome' in body) {
          await audit({ action: AUDIT_ACTIONS.sessionGrade, entityTable: 'sessions', entityId: id, capabilityCode: 'training.sessions.grade',
            details: { person_id: personId, outcome: text(body.outcome, 40) } }, actor, ctx);
        }
        return NextResponse.json({ ok: true, saved_at: saved.savedAt });
      }

      default:
        return NextResponse.json({ ok: false, error: 'unknown_kind' }, { status: 400 });
    }
  } catch (err) {
    return refused(err);
  }
}
