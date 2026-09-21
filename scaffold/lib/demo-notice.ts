import { cookies } from 'next/headers';

/**
 * lib/demo-notice.ts - the acceptance gate that stands in front of the DEPLOYED demonstration.
 *
 * WHY IT IS KEYED ON APP_ENV AND NOT ON A SEPARATE BUILD. docs/02 is explicit that the server is
 * rebuilt from the repository and never patched, so a server-only screen cannot be a server-only
 * branch of the code. `APP_ENV` is `prod` from deploy/compose.prod.yml and `dev` on a workstation,
 * it is read at RUNTIME (every page here is nodejs + force-dynamic), and it is the same value the
 * health endpoint already reports. One image, two behaviours, decided by the environment it runs in.
 *
 * WHY A SESSION COOKIE AND NOT A STORED CONSENT. Nobody signs anything here: this is a notice, not
 * a contract, and recording who clicked it would mean collecting a person before they have even
 * seen the login screen. The cookie has no maxAge, so it dies with the browser session and the
 * notice is shown again on the next visit - which is what a demonstration opened in front of a room
 * should do.
 *
 * VERSIONED. Change NOTICE_VERSION when the wording changes and every existing acceptance lapses,
 * because an acceptance of wording nobody can read any more is not an acceptance.
 */

export const NOTICE_COOKIE = 'ava_notice';
export const NOTICE_VERSION = '2026-09-21';

/** True when this deployment shows the notice at all. */
export function noticeApplies(): boolean {
  return process.env.APP_ENV === 'prod';
}

/** True when the notice must be shown before the caller may go any further. */
export async function noticeRequired(): Promise<boolean> {
  if (!noticeApplies()) return false;
  const jar = await cookies();
  return jar.get(NOTICE_COOKIE)?.value !== NOTICE_VERSION;
}

/**
 * A same-origin path, or '/'. An absolute URL echoed back into a redirect is an open redirect, and
 * an open redirect in front of a login page is a phishing primitive - the same rule the login page
 * already applies to its own `next`.
 */
export function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
