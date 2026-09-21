import { NextResponse, type NextRequest } from 'next/server';
import { seeOther } from '@/lib/http';
import { NOTICE_COOKIE, NOTICE_VERSION, noticeApplies, safeNext } from '@/lib/demo-notice';

/**
 * POST /api/disclaimer - record that the demonstration notice was accepted, in this browser
 * session only.
 *
 * THE TICK IS CHECKED HERE, not only in the markup. `required` on the checkbox is the browser
 * being helpful; a post without it still reaches this route from anything that is not a browser,
 * and a gate that only exists in HTML is not a gate.
 *
 * NO maxAge: a session cookie. It dies when the browser closes, so the notice is shown again on
 * the next visit. `secure` follows the same rule as the session cookie - on behind the tunnel,
 * off on plain http so a workstation is not locked out by a cookie the browser will not store.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!noticeApplies()) return seeOther('/');

  const form = await request.formData();
  const next = safeNext(typeof form.get('next') === 'string' ? (form.get('next') as string) : undefined);

  if (form.get('agree') !== 'yes') {
    // Not an error page: they simply have not accepted, which is the same state as arriving.
    return seeOther(`/disclaimer?next=${encodeURIComponent(next)}`);
  }

  const res = seeOther(next);
  res.cookies.set({
    name: NOTICE_COOKIE,
    value: NOTICE_VERSION,
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: '/',
  });
  return res;
}

/** A GET here is somebody typing the URL. Send them to the notice rather than a 405. */
export async function GET(): Promise<NextResponse> {
  return seeOther('/disclaimer');
}
