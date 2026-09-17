import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { seeOther, pathWithQuery } from '@/lib/http';
import { resolveAccess, can } from '@/lib/access';
import { audit, actorFromSession, requestContext, AUDIT_ACTIONS } from '@/lib/audit';
import { createSession, CreateRefused, heldRoleCodes, type CreateInput } from '@/lib/sessions';

/**
 * POST /api/sessions - open one session against a published program.
 *
 * Every eligibility rule is re-checked inside `createSession` against the database: published
 * version, `allowed_assessor_roles` against this person's own qualifications, the fleet binding on
 * the grant, the device against the operator context, the pilot against the active roster. The form
 * mirrors those rules; it does not enforce them, because a form is a suggestion.
 *
 * A refusal is a sentence, not a code: the instructor needs to know which rule stopped them.
 *
 * Gate: training.sessions.create.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  if (!can(access, 'training.sessions.create')) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });

  const wantsJson = (request.headers.get('content-type') ?? '').includes('application/json');
  const form = wantsJson ? ((await request.json()) as Record<string, unknown>) : Object.fromEntries(await request.formData());
  const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '');
  const num = (k: string) => { const v = str(k); return v === '' ? null : Number(v); };

  const input: CreateInput = {
    version_id: str('version_id'),
    subject_id: str('subject_id'),
    seat_role: str('seat_role'),
    session_date: str('session_date'),
    device: str('device') || null,
    facility: str('facility') || null,
    check: str('check') || null,
    departure: str('departure').toUpperCase() || null,
    arrival: str('arrival').toUpperCase() || null,
    registration: str('registration').toUpperCase() || null,
    sector_number: num('sector_number'),
  };

  // The caller's own platform roles, read from their grants - never from the form. This is the
  // vocabulary allowed_assessor_roles speaks; the aviation qualification on the roster row is not.
  const roleCodes = await heldRoleCodes(session.userId);

  try {
    const id = await createSession(input, { personId: session.personId, userId: session.userId, roleCodes }, access);
    await audit(
      {
        action: AUDIT_ACTIONS.sessionCreate,
        entityTable: 'sessions',
        entityId: id,
        capabilityCode: 'training.sessions.create',
        details: { version_id: input.version_id, subject_id: input.subject_id, seat_role: input.seat_role, session_date: input.session_date, device: input.device, check: input.check },
      },
      actorFromSession(session),
      requestContext(request.headers),
    );
    if (wantsJson) return NextResponse.json({ ok: true, id });
    return seeOther(`/sessions/${id}`);
  } catch (err) {
    const message = err instanceof CreateRefused ? err.message : 'The session could not be opened.';
    if (!(err instanceof CreateRefused)) console.error('[sessions] create failed', err);
    if (wantsJson) return NextResponse.json({ ok: false, error: message }, { status: 400 });
    return seeOther(pathWithQuery('/sessions/new', { problem: message }));
  }
}
