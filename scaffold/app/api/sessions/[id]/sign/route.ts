import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { resolveAccess, canOnPerson } from '@/lib/access';
import { audit, actorFromSession, requestContext, AUDIT_ACTIONS } from '@/lib/audit';
import { signSession, unsignSession, SignRefused } from '@/lib/program/signing';

/**
 * POST /api/sessions/[id]/sign - one signature, or the removal of every signature.
 *
 *   { action: 'sign',   person_id, party: 'assessor' | 'subject', secret }
 *   { action: 'unsign', person_id, password, reason }
 *
 * `secret` is the signer's own account password - or, only where that person has no account at all,
 * their employee id. lib/program/signing.ts decides which and records which was actually used.
 *
 * The rules are in lib/program/signing.ts; this is the seam. Two things belong here rather than
 * there: the audit rows, which name the act and never what was typed, and the refusal
 * mapping - a rule refusal is 409 with its own sentence, because every one of them is something the
 * instructor can act on ("enter the outcome first", "the instructor signs first", "that is not your
 * employee id") and a bare 403 would tell them nothing.
 *
 * Unlike the grading route, EVERY call here is audited. A signature and its removal are exactly the
 * acts the grade rows cannot describe, and the ones a regulator reads the log for.
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
    if (action === 'sign') {
      const party = body.party === 'subject' ? 'subject' : 'assessor';
      const result = await signSession({
        sessionId: id, personId, party,
        secret: String(body.secret ?? ''),
        userId: session.userId, actorPersonId: session.personId ?? null,
      }, access);
      await audit({
        action: AUDIT_ACTIONS.sessionSign, entityTable: 'sessions', entityId: id, capabilityCode: 'training.sessions.sign',
        details: { party, person_id: personId, content_hash: result.hash, status: result.status, method: result.method },
      }, actor, ctx);
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'unsign') {
      const reason = String(body.reason ?? '').slice(0, 2000);
      const result = await unsignSession({
        sessionId: id, password: String(body.password ?? ''), reason, userId: session.userId,
      }, access);
      await audit({
        action: AUDIT_ACTIONS.sessionUnsign, entityTable: 'sessions', entityId: id, capabilityCode: 'training.sessions.unsign',
        reason, details: { person_id: personId },
      }, actor, ctx);
      return NextResponse.json({ ok: true, ...result });
    }

    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  } catch (err) {
    if (err instanceof SignRefused) {
      if (err.message === 'not_found') return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
      return NextResponse.json({ ok: false, error: 'refused', message: err.message }, { status: 409 });
    }
    const status = (err as { status?: number }).status;
    if (status === 403) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    throw err;
  }
}
