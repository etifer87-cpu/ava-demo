import { NextResponse } from 'next/server';

/**
 * http.ts - redirects that survive being behind something.
 *
 * WHY THIS EXISTS. Every form POST in the platform answers with a 303 back to a page, and each one
 * used to build its destination as `new URL(path, request.nextUrl.origin)`. That origin is whatever
 * the SERVER believes it is, and a server in a container believes what it was bound to: with
 * HOSTNAME=0.0.0.0 and PORT=3000 the first crew session ever opened redirected the browser to
 * `http://0.0.0.0:3000/sessions/…`, which is not an address a browser can go to. The session had
 * been created correctly; only the way back was wrong, which is the most confusing kind of wrong.
 *
 * Behind Cloudflare it would be the same story with a different address: the browser asks for
 * https://ava.example.com and the app answers "go to http://0.0.0.0:3000", and the operator sees a
 * dead page after every save.
 *
 * A RELATIVE Location avoids the question entirely. RFC 7231 allows it, every browser resolves it
 * against the URL it actually requested, and the server never has to guess its own name. There is
 * nothing to configure and nothing to get wrong in a new environment.
 *
 * So: no route builds an absolute redirect. If you find yourself reaching for an origin, you want
 * `seeOther` instead.
 */

/**
 * 303 See Other to a path on this site. Cookies can be set on the returned response as usual -
 * `res.cookies.set(...)` works exactly as it does on NextResponse.redirect.
 *
 * `path` must be site-relative and start with "/". An absolute URL would reintroduce the bug and a
 * caller-supplied one would be an open redirect, so both are refused rather than sanitised: a
 * redirect that quietly goes somewhere else is worse than one that fails in the test.
 */
export function seeOther(path: string, status: 302 | 303 = 303): NextResponse {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`seeOther expects a site-relative path beginning with a single "/", received: ${path}`);
  }
  return new NextResponse(null, { status, headers: { Location: path } });
}

/**
 * Build "/path?query" without inventing an origin.
 *
 * The URL class needs a base to parse against, so this uses a throwaway one and then keeps only the
 * parts that belong to this site. The base never reaches the browser. Parameters whose value is
 * null or undefined are omitted rather than written as the string "null".
 */
export function pathWithQuery(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const url = new URL(path, 'http://relative.invalid');
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}
