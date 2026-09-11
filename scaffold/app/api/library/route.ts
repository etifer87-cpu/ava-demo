import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { actorFromSession, requestContext } from '@/lib/audit';
import { flashCookie } from '@/lib/admin';
import { createLibraryElement, isLibraryKind } from '@/lib/program/library';

/**
 * POST /api/library - create one library element by hand (a malfunction, an inject, a weather
 * set, an ATC line, a task). `_action`: create. Returns to where the form was (`return`, a
 * /templates path) with the new element's code selected in the rail. Gate: training.library.manage.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.library.manage');

  const form = await request.formData();
  const str = (k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
  const ret = str('return', 300);
  const to = ret.startsWith('/templates') ? ret : '/templates';

  const back = (flash: Parameters<typeof flashCookie>[0], code: string | null) => {
    const url = new URL(to, request.nextUrl.origin);
    if (code) url.searchParams.set('lib', code);
    const res = NextResponse.redirect(url, 303);
    res.cookies.set(flashCookie(flash, '/templates'));
    return res;
  };

  if (str('_action', 20) !== 'create') return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  const kind = str('kind', 20);
  if (!isLibraryKind(kind)) return back({ kind: 'bad', message: 'Choose a library kind.' }, null);

  try {
    const code = await createLibraryElement({
      kind, title: str('title', 200), code: str('code', 63) || null, fleet: str('fleet', 20) || null, summary: str('summary', 300) || null, text: str('text', 2000) || null,
    }, actorFromSession(session), requestContext(request.headers));
    return back({ kind: 'ok', message: `Added to the library as ${code}.` }, code);
  } catch (err) {
    return back({ kind: 'bad', message: err instanceof Error ? err.message : 'Not added.' }, null);
  }
}
