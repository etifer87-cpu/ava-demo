import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { brand } from '@/lib/config';
import { noticeRequired } from '@/lib/demo-notice';

/**
 * The credential entry screen. A plain POST form: no client component, no fetch, no token in
 * browser storage. The only thing this page produces is a form submission, and the only thing the
 * caller receives back is an httpOnly cookie.
 *
 * Failures are reported through a query parameter with a FIXED, GENERIC message. It never says
 * whether the username exists: an error that distinguishes "no such user" from "wrong password" is
 * a username oracle, and enumerating an operator's staff list from it takes minutes.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MESSAGES: Readonly<Record<string, string>> = {
  invalid: 'Those credentials were not accepted.',
  locked: 'This account is temporarily locked after repeated failed attempts. Try again later.',
  missing: 'Enter a username and a password.',
  unavailable: 'Sign-in is unavailable. The server log has the detail.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const sp = await searchParams;

  /* The deployed demonstration asks for the notice BEFORE the credential form. Checked before the
     session lookup so that arriving with a stale cookie does not skip it. Returns here afterwards,
     carrying the caller's own `next` so the detour is invisible. */
  if (await noticeRequired()) {
    const back = sp.next && sp.next.startsWith('/') && !sp.next.startsWith('//')
      ? `/login?next=${encodeURIComponent(sp.next)}`
      : '/login';
    redirect(`/disclaimer?next=${encodeURIComponent(back)}`);
  }

  const session = await getSession();
  if (session) redirect(sp.next && sp.next.startsWith('/') ? sp.next : '/');

  const b = brand();
  const message = sp.error ? (MESSAGES[sp.error] ?? MESSAGES.invalid) : null;
  // Only a same-origin path is ever echoed back into the form. An absolute URL here is an open
  // redirect, and an open redirect on a login page is a phishing primitive.
  const next = sp.next && sp.next.startsWith('/') && !sp.next.startsWith('//') ? sp.next : '/';

  return (
    <div className="stack" style={{ maxWidth: '26rem', margin: '0 auto' }}>
      {b.logo.path ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={b.logo.path} alt={b.logo.alt || b.product.name} height={b.logo.height_px * 1.5} style={{ alignSelf: 'flex-start' }} />
      ) : null}
      <h1>{b.product.name}</h1>

      {message ? (
        <div className="notice notice-bad" role="alert">
          {message}
        </div>
      ) : null}

      <form className="card stack" method="post" action="/api/auth/login" data-testid="login-form">
        <input type="hidden" name="next" value={next} />
        <div className="field">
          <label htmlFor="username">Username</label>
          <input id="username" name="username" autoComplete="username" required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <div>
          <button className="button" type="submit">Sign in</button>
        </div>
      </form>

      <p className="xs muted">
        Sessions are cookie-based and expire. Closing the browser does not end a session; use Sign
        out.
      </p>
    </div>
  );
}
