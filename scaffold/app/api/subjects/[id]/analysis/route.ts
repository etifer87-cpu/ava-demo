import { NextResponse, type NextRequest } from 'next/server';
import { seeOther, pathWithQuery } from '@/lib/http';
import { requireSession } from '@/lib/session';
import { resolveAccess, can, canOnPerson } from '@/lib/access';
import { audit, actorFromSession, requestContext, AUDIT_ACTIONS } from '@/lib/audit';
import { runSubjectAnalysis } from '@/lib/analytics/subject-narrative';

/**
 * POST /api/subjects/[id]/analysis - request one analysis run for one pilot.
 *
 * Two capabilities, both required: `training.analysis.run` at all, and `people.view` on THIS
 * pilot - the second row-checked, because an analysis is the most complete thing the platform
 * will ever say about a person and a capability held "at all" is not permission to read anyone.
 *
 * SYNCHRONOUS ON PURPOSE, for now. The honest version of a queue is a worker, a poll and a place
 * for a job to die quietly; the honest version of a demo is a button that takes a few seconds and
 * either produces a report or says why not. When this becomes a queue, the run row is already
 * shaped for it - `queued`, `running`, `complete` - and this route becomes the enqueue.
 *
 * Every outcome is stored, including the refusals. A gate that rejects a narrative without
 * leaving a row would be indistinguishable from a model that was never asked.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A deep-tier call plus the gate. The default serverless budget is not the right one here. */
export const maxDuration = 300;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();
  const access = await resolveAccess(session);

  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const refuse = (message: string, status: number) =>
    wantsJson
      ? NextResponse.json({ ok: false, error: message }, { status })
      : seeOther(pathWithQuery(`/subjects/${id}/analysis`, { problem: message }));

  if (!can(access, 'training.analysis.run')) {
    return refuse('Your account cannot request an analysis.', 403);
  }
  // Same answer for "may not see this person" and "no such person": distinguishing them turns
  // this route into a way of discovering who is on the roster.
  if (!(await canOnPerson(access, 'people.view', id))) {
    return refuse('That pilot is not in your scope.', 404);
  }

  try {
    const run = await runSubjectAnalysis({ personId: id, requestedBy: session.userId });
    if (!run) return refuse('That pilot is not on the roster.', 404);

    await audit(
      {
        action: AUDIT_ACTIONS.analysisRun,
        entityTable: 'analysis_runs',
        entityId: run.id,
        capabilityCode: 'training.analysis.run',
        // The VERDICT is audited, not just the request: "rejected" is the safety property doing
        // its job, and it is the line somebody will want to find again months later.
        details: {
          person_id: id,
          status: run.status,
          provenance: run.provenance?.provenanceScore ?? null,
          coverage: run.provenance?.coverageScore ?? null,
          error: run.error,
        },
      },
      actorFromSession(session),
      requestContext(request.headers),
    );

    if (wantsJson) return NextResponse.json({ ok: true, id: run.id, status: run.status });
    return seeOther(pathWithQuery(`/subjects/${id}/analysis`, { run: run.id }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The analysis could not be run.';
    console.error('[analysis] run failed', err);
    return refuse(message, 500);
  }
}
