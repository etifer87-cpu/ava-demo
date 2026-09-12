import { NextResponse, type NextRequest } from 'next/server';
import { queryOne } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, can, canOnPerson } from '@/lib/access';
import type { RecordListRow } from '@/components/program/RecordDialog';

/**
 * GET /api/records/[id] - one record, in the shape the record pop-up renders (RecordListRow).
 *
 * Read by the initial-training board when a sector row is clicked: the board carries every
 * pilot's sector list but not the frozen snapshots, which are fetched one at a time here. Gate:
 * training.records.view plus people.view on the record's subject - the same two checks the pilot
 * page makes before it lists records. A record the caller may not see answers 404, not 403, so
 * the endpoint never confirms that an id exists.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  const session = await requireSession();
  const access = await resolveAccess(session);
  if (!can(access, 'training.records.view')) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });

  const row = await queryOne<RecordListRow & { person_id: string }>(
    `SELECT r.id, r.person_id, r.title, r.record_kind, r.training_date::text AS training_date,
            r.outcome, r.outcome_override, ac.code AS asset_class, p.full_name AS assessor_name, r.is_hidden_from_subject, r.snapshot,
            (SELECT count(*)::text FROM record_competencies rc WHERE rc.record_id = r.id) AS competency_count
       FROM records r
       LEFT JOIN asset_classes ac ON ac.id = r.asset_class_id
       LEFT JOIN people p ON p.id = r.assessor_person_id
      WHERE r.id = $1::uuid AND r.deleted_at IS NULL`,
    [id],
  );
  if (!row || !(await canOnPerson(access, 'people.view', row.person_id))) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  const { person_id: _omit, ...record } = row;
  return NextResponse.json({ ok: true, record });
}
