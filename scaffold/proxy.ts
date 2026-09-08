import { NextResponse, type NextRequest } from 'next/server';
import { verifySessionCookie, SESSION_COOKIE_NAME } from '@/lib/session';

/**
 * proxy.ts - the route-level auth gate.
 *
 * NAMING: this file is `proxy.ts` because Next.js 16 renamed the request interceptor from
 * `middleware.ts` to `proxy.ts` (default export `proxy`, same position in the request path, Node
 * runtime by default). On Next.js 15 and earlier the identical file is named `middleware.ts` with
 * a `middleware` export. If a future upgrade complains that no interceptor was found, this rename
 * is the reason - the contents do not change.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is a FILTER: it turns an unauthenticated request into a redirect or a 401 before a page or a
 * handler does any work. It is NOT the authorisation boundary. Every route handler still calls
 * requireSession() and then requireCapability() / requireOnPerson() against the database, because:
 *
 *   - this file verifies a signature and an expiry, and knows nothing about roles;
 *   - a served prebuilt bundle keeps enforcing whatever rules it was built with;
 *   - an internal caller can reach a handler without passing through here at all.
 *
 * A gate that the application relies on for authorisation is a gate that will one day be bypassed
 * by a call path nobody remembered.
 *
 * THE ALLOW-LIST IS THE INVERSE OF app/ROUTES.md: anything not listed as public requires a session.
 * A new public route is closed until it is added here, because "we forgot to add it" must fail as
 * a locked door rather than as an open one.
 */

const PUBLIC_EXACT = new Set<string>(['/login', '/api/auth/login', '/api/health']);

/** Static and framework paths that never carry data. */
const PUBLIC_PREFIXES = ['/_next/', '/favicon', '/fonts/', '/images/', '/logo'];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export default function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const raw = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const payload = safeVerify(raw);
  if (payload) return NextResponse.next();

  // An API caller gets a status it can act on. A browser gets the login page, with the destination
  // preserved so that signing in lands where the caller was going instead of on a generic home.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

/**
 * verifySessionCookie throws when SESSION_SECRET is missing or too short. Here that must present
 * as "not signed in" rather than as a 500 on every route including /login, which would make a
 * misconfigured deployment impossible to log into and hard to diagnose.
 */
function safeVerify(raw: string | undefined) {
  try {
    return verifySessionCookie(raw);
  } catch (err) {
    console.error('[proxy] session verification unavailable', err);
    return null;
  }
}

export const config = {
  /**
   * Everything except the framework's own asset paths. The exclusions here are a performance
   * measure only; the allow-list above is what decides.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
