import { NextResponse, type NextRequest } from 'next/server';
import { getSession, SESSION_COOKIE_NAME } from '@/lib/session';
import { auditFor, AUDIT_ACTIONS } from '@/lib/audit';

/**
 * POST /api/auth/logout
 *
 * POST only. A GET that ends a session can be triggered by a prefetch, a link scanner or an image
 * tag on another site, and users then report "it logs me out at random".
 *
 * The cookie is cleared by setting it empty with maxAge 0 on the same path. Clearing it only in
 * the browser would leave a cookie that still verifies; there is no server-side session store to
 * invalidate, which is the trade this cookie design makes - short lifetime, re-read identity on
 * every request, no store to keep consistent.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (session) {
    await auditFor(session, request.headers, {
      action: AUDIT_ACTIONS.authLogout,
      entityTable: 'users',
      entityId: session.userId,
    });
  }

  const wantsJson = (request.headers.get('content-type') ?? '').includes('application/json');
  const response = wantsJson
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(new URL('/login', request.nextUrl.origin), 303);

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: '',
    maxAge: 0,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
  return response;
}
