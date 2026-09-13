import { NextResponse, type NextRequest } from 'next/server';
import { queryOne, transaction } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, can, canOnPerson } from '@/lib/access';
import { audit, actorFromSession, requestContext, AUDIT_ACTIONS } from '@/lib/audit';

/**
 * POST /api/instructors/[id]/alerts - decide one standardisation alert.
 *
 * Body (form or JSON): record_id, alert_type, status (confirmed | dismissed | open), reviewer_note,
 * and competency_id for a grade-level alert.
 *
 * THE NOTE IS MANDATORY for a decision, here as well as in the CHECK constraint (migration 0148).
 * Dismissing an alert without a reason is indistinguishable from never looking at it, and the
 * difference is the whole value of the queue in a standardisation conversation months later.
 *
 * Two capabilities, both required: training.analytics.assessor.view on THIS instructor - which is
 * false for the holder themselves, so nobody closes their own alerts - and training.records.amend,
 * which the assessment manager holds and a line instructor does not.
 *
 * 'open' is accepted as a status and REOPENS an alert by soft-deleting the decision, rather than
 * storing a decision that says nothing.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const TYPES = new Set(['unjustified_low', 'halo_record', 'outcome_mismatch', 'masking']);
const STATUSES = new Set(['open', 'dismissed', 'confirmed']);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const session = await requireSession();
  const access = await resolveAccess(session);
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const back = (message: string, ok = true) => {
    if (wantsJson) return NextResponse.json({ ok, message }, { status: ok ? 200 : 400 });
    const url = new URL(`/instructors/${id}/analysis`, request.nextUrl.origin);
    url.searchParams.set(ok ? 'done' : 'problem', message);
    return NextResponse.redirect(url, 303);
  };

  if (!(await canOnPerson(access, 'training.analytics.assessor.view', id)) || !can(access, 'training.records.amend')) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const form = request.headers.get('content-type')?.includes('application/json')
    ? ((await request.json()) as Record<string, unknown>)
    : Object.fromEntries(await request.formData());
  const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '');
  const recordId = str('record_id');
  const competencyId = str('competency_id');
  const alertType = str('alert_type');
  const status = str('status');
  const note = str('reviewer_note');

  if (!UUID.test(recordId) || !TYPES.has(alertType) || !STATUSES.has(status)) return back('That alert could not be identified.', false);
  if (competencyId && !UUID.test(competencyId)) return back('That alert could not be identified.', false);
  if (status !== 'open' && note.length < 3) return back('A decision needs a reviewer note saying why.', false);

  // The alert must belong to a record this instructor actually signed: otherwise the endpoint would
  // accept a decision on somebody else's record by id.
  const owns = await queryOne<{ ok: boolean }>(
    `SELECT true AS ok FROM records WHERE id = $1::uuid AND assessor_person_id = $2::uuid AND deleted_at IS NULL`,
    [recordId, id],
  );
  if (!owns) return back('That record does not belong to this instructor.', false);

  await transaction(async (client) => {
    if (status === 'open') {
      await client.query(
        `UPDATE assessor_remark_audit SET deleted_at = now()
          WHERE assessor_person_id = $1::uuid AND record_id = $2::uuid AND alert_type = $3
            AND COALESCE(competency_id, '00000000-0000-0000-0000-000000000000'::uuid)
                = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
            AND deleted_at IS NULL`,
        [id, recordId, alertType, competencyId || null],
      );
    } else {
      await client.query(
        `INSERT INTO assessor_remark_audit (assessor_person_id, record_id, competency_id, alert_type, status, reviewer_note, decided_by, decided_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, now())
         ON CONFLICT (record_id, (COALESCE(competency_id, '00000000-0000-0000-0000-000000000000'::uuid)), alert_type) WHERE deleted_at IS NULL
         DO UPDATE SET status = EXCLUDED.status, reviewer_note = EXCLUDED.reviewer_note,
                       decided_by = EXCLUDED.decided_by, decided_at = now()`,
        [id, recordId, competencyId || null, alertType, status, note, session.userId],
      );
    }
  });

  await audit(
    {
      action: AUDIT_ACTIONS.recordAmend,
      entityTable: 'assessor_remark_audit',
      entityId: recordId,
      capabilityCode: 'training.records.amend',
      reason: note || null,
      details: { instructor_person_id: id, record_id: recordId, competency_id: competencyId || null, alert_type: alertType, status },
    },
    actorFromSession(session),
    requestContext(request.headers),
  );

  return back(status === 'open' ? 'Alert reopened.' : `Alert ${status}.`);
}

export async function GET() {
  return NextResponse.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
}
