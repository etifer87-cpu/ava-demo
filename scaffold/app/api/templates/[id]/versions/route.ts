import { NextResponse, type NextRequest } from 'next/server';
import { seeOther, pathWithQuery } from '@/lib/http';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { actorFromSession, requestContext } from '@/lib/audit';
import { flashCookie } from '@/lib/admin';
import { publishVersion, newDraftFrom } from '@/lib/program/publish';

/**
 * POST /api/templates/[id]/versions - the builder header's version actions. `_action`:
 *
 *   publish     version=<id>   draft -> published (refused on blockers); previous published retired
 *   new_draft   version=<id>   a new draft cloned from that version, opened in the builder
 *
 * Redirects back to the builder with a flash. Gate: training.templates.configure.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.templates.configure');
  const { id } = await params;
  const form = await request.formData();
  const action = String(form.get('_action') ?? '').slice(0, 20);
  const versionId = String(form.get('version') ?? '');
  const back = (kind: 'ok' | 'warn' | 'bad', message: string, toVersion?: string) => {
    const res = seeOther(pathWithQuery(`/templates/${id}`, { version: toVersion }));
    res.cookies.set(flashCookie({ kind, message }, '/templates'));
    return res;
  };
  if (!UUID.test(id) || !UUID.test(versionId)) return back('bad', 'Unknown version.');
  const actor = actorFromSession(session);
  const ctx = requestContext(request.headers);
  try {
    if (action === 'publish') { const r = await publishVersion(versionId, session.userId, actor, ctx); return back(r.ok ? 'ok' : 'bad', r.message); }
    if (action === 'new_draft') { const r = await newDraftFrom(versionId, actor, ctx); return back(r.ok ? 'ok' : 'warn', r.message, r.versionId); }
    return back('bad', 'Unknown action.');
  } catch (err) {
    return back('bad', err instanceof Error ? err.message : 'The change was not made.');
  }
}
