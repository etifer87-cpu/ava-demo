import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { resolveAccess, canOnPerson } from '@/lib/access';
import { audit, actorFromSession, requestContext, AUDIT_ACTIONS } from '@/lib/audit';
import { finaliseRecord, objectToRecord, FreezeRefused } from '@/lib/program/freeze';

/**
 * POST /api/sessions/[id]/finalise - the two acts that end an ETR.
 *
 *   { action: 'object',   person_id, reason, secret }   the pilot objects instead of signing
 *   { action: 'finalise', person_id }                   freeze this pilot's part into a record
 *
 * Both are audited in full: `session.finalize` is the moment a training record comes into existence,
 * and an objection is the one thing a manager will be asked about. The rules, including who may do
 * either and what state the session has to be in, are in lib/program/freeze.ts.
 *
 * The analytics are NOT refreshed here - see the note at the top of that file. `npm run
 * analytics:refresh` is what puts a new record on the bench pages; the pilot's own pages read
 * `records` and show it immediately.
 *
 * The record's PDF is rendered and stored as part of finalising (0152). A renderer that is down does
 * NOT fail the finalise: the answer carries `pdf_problem` so the surface can say so, and the download
 * link renders one on first use.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const session = await requireSession();
  const access = await resolveAccess(session);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const action = String(body.action ?? '');
  const personId = String(body.person_id ?? '');
  if (!UUID.test(personId)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  if (!(await canOnPerson(access, 'people.view', personId))) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

  const actor = actorFromSession(session);
  const ctx = requestContext(request.headers);

  try {
    if (action === 'object') {
      const reason = String(body.reason ?? '').slice(0, 4000);
      const result = await objectToRecord({
        sessionId: id, personId, reason, secret: String(body.secret ?? ''), userId: session.userId,
      }, access);
      await audit({
        action: AUDIT_ACTIONS.sessionSign, entityTable: 'session_subjects', entityId: id,
        capabilityCode: 'training.sessions.sign', reason,
        details: { objection: true, person_id: personId, notified: result.notified },
      }, actor, ctx);
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'finalise') {
      const result = await finaliseRecord({ sessionId: id, personId, userId: session.userId }, access);
      await audit({
        action: AUDIT_ACTIONS.sessionFinalize, entityTable: 'records', entityId: result.recordId,
        capabilityCode: 'training.sessions.finalize',
        details: { session_id: id, person_id: personId, outcome: result.outcome, tasks: result.tasks,
          competencies: result.competencies, pdf: result.pdfProblem === null ? 'stored' : result.pdfProblem },
      }, actor, ctx);
      return NextResponse.json({ ok: true, record_id: result.recordId, outcome: result.outcome,
        tasks: result.tasks, competencies: result.competencies, pdf_problem: result.pdfProblem });
    }

    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  } catch (err) {
    if (err instanceof FreezeRefused) {
      if (err.message === 'not_found') return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
      return NextResponse.json({ ok: false, error: 'refused', message: err.message }, { status: 409 });
    }
    const status = (err as { status?: number }).status;
    if (status === 403) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    // A fault, not a refusal. It is logged with a prefix that can be grepped, and OUTSIDE PRODUCTION
    // the message goes back to the surface as well: a 500 with no words behind it costs an hour of
    // guessing, and the only person who sees this instance is the one building it.
    const e = err as { message?: string; code?: string; detail?: string; constraint?: string };
    console.error('[finalise] session', id, 'person', personId, '-', e.code ?? '', e.message ?? err, e.detail ?? '', e.constraint ?? '');
    if (process.env.NODE_ENV !== 'production') {
      return NextResponse.json({ ok: false, error: 'fault', message: `${e.code ? `[${e.code}] ` : ''}${e.message ?? 'unknown fault'}${e.detail ? ` - ${e.detail}` : ''}` }, { status: 500 });
    }
    throw err;
  }
}
