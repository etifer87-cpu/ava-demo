import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { resolveAccess, can, canOnPerson } from '@/lib/access';
import { brand } from '@/lib/config';
import { audit, actorFromSession, requestContext, AUDIT_ACTIONS } from '@/lib/audit';
import { ensureRecordPdf, recordForPrint, recordFileName, storeRecordPdf } from '@/lib/program/record-pdf';
import { PdfUnavailable } from '@/lib/pdf';

/**
 * GET /api/records/[id]/pdf - the record as a PDF.
 *
 * Serves the file stored at finalisation (migration 0152). If there is none - the renderer was down at
 * that moment - it renders and stores one now, so a download is always possible and the second one is
 * a re-read rather than a re-render. `?refresh=1` re-renders deliberately, which is for a record whose
 * outcome was amended after the fact.
 *
 * Gate: the same two checks as GET /api/records/[id] - `training.records.view` plus `people.view` on
 * the record's subject - and 404 rather than 403 for a record the caller may not see, so the endpoint
 * never confirms that an id exists. The export is audited, because who took a copy of a training
 * record off the system is a question that gets asked.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });

  const session = await requireSession();
  const access = await resolveAccess(session);
  if (!can(access, 'training.records.view')) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });

  const rec = await recordForPrint(id);
  if (!rec || !(await canOnPerson(access, 'people.view', rec.person_id))) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  try {
    const refresh = request.nextUrl.searchParams.get('refresh') === '1';
    const pdf = refresh ? await storeRecordPdf(id, session.userId) : await ensureRecordPdf(id, session.userId);
    const name = recordFileName(rec, brand().product?.short_name ?? 'record');

    await audit({
      action: AUDIT_ACTIONS.exportPdf, entityTable: 'records', entityId: id, capabilityCode: 'training.records.view',
      details: { person_id: rec.person_id, bytes: pdf.byteSize, sha256: pdf.sha256, re_rendered: refresh },
    }, actorFromSession(session), requestContext(request.headers));

    return new NextResponse(new Uint8Array(pdf.bytes), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(pdf.byteSize),
        // inline: a training officer looks at it before deciding to keep it.
        'content-disposition': `inline; filename="${name}"`,
        'cache-control': 'private, no-store',
        'x-content-sha256': pdf.sha256,
      },
    });
  } catch (err) {
    if (err instanceof PdfUnavailable) {
      return NextResponse.json({ ok: false, error: 'renderer', message: err.message }, { status: 503 });
    }
    throw err;
  }
}
