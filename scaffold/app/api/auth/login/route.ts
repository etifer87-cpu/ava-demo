import { NextResponse, type NextRequest } from 'next/server';
import { seeOther, pathWithQuery } from '@/lib/http';
import { query, queryOne } from '@/lib/db';
import { issueSessionCookie } from '@/lib/session';
import { audit, AUDIT_ACTIONS, requestContext } from '@/lib/audit';

/**
 * POST /api/auth/login
 *
 * Handlers export handlers and configuration only. The rule is bent in exactly one direction here:
 * the credential check is a single statement and lives inline rather than in lib/, because moving
 * it to a shared helper is how a second caller ends up verifying a password without the lockout.
 *
 * The password is verified BY POSTGRES, with pgcrypto's crypt(): `password_hash = crypt($pw,
 * password_hash)`. The stored hash is bcrypt (migration 0006, cost from app_settings), the salt
 * and cost travel inside the hash, and the comparison is constant-time in the extension. No hash
 * ever leaves the database, and the application needs no crypto dependency of its own.
 *
 * Accepts a form post (the login page) or JSON (a script). A form post is answered with a 303 so
 * that reloading the destination does not repost credentials.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CandidateRow {
  id: string;
  password_ok: boolean;
  is_locked: boolean;
  must_change_password: boolean;
  failed_login_count: number;
}

const CANDIDATE_SQL = `
  SELECT u.id,
         (u.password_hash = crypt($2, u.password_hash)) AS password_ok,
         (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked,
         u.must_change_password,
         u.failed_login_count
    FROM users u
   WHERE u.username = $1
     AND u.is_active
     AND u.deleted_at IS NULL
`;

const SETTING_SQL = `SELECT value::text AS value FROM app_settings WHERE key = $1`;

async function settingInt(key: string, fallback: number): Promise<number> {
  const row = await queryOne<{ value: string }>(SETTING_SQL, [key]);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A username is an IDENTIFIER, so it is compared as bytes and anything invisible in it is a bug.
 *
 * WHY THIS IS NOT PARANOIA. On 2026-09-21 nobody could sign in to the deployed demonstration.
 * The audit log showed `{"username": "l.guerrero"}` and the users table held `l.guerrero`, and the
 * lookup matched neither: the submitted string was `e2808b6c2e...` - a leading U+200B ZERO WIDTH
 * SPACE, picked up by copying the name out of rendered text and then remembered by the browser's
 * autofill. `.trim()` does not remove it because it is not whitespace, it renders as nothing at
 * all, and the failure presents as "those credentials were not accepted" - a wrong-password
 * message for a username that was never found. `failed_login_count` stays at 0 and the audit row
 * carries no user id, which is the only visible trace.
 *
 * So: normalise, then drop every format character (\p{Cf}: zero-width space, zero-width joiner,
 * the BOM, bidi marks) and every space (\p{Zs}: including U+00A0, which a copy out of HTML
 * routinely carries). No username in this system contains a space, so removing them cannot turn
 * one account's name into another's.
 *
 * THE PASSWORD IS NOT TOUCHED. A password is a secret, not an identifier: every byte of it is
 * meaningful, and silently editing one would make a correct password fail and an incorrect one
 * occasionally pass.
 */
function cleanUsername(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').replace(/[\p{Cf}\p{Zs}\s]/gu, '');
}

async function readCredentials(request: NextRequest) {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      username: cleanUsername(body.username),
      password: typeof body.password === 'string' ? body.password : '',
      next: typeof body.next === 'string' ? body.next : '/',
      wantsJson: true,
    };
  }
  const form = await request.formData();
  return {
    username: cleanUsername(form.get('username')),
    password: String(form.get('password') ?? ''),
    next: String(form.get('next') ?? '/'),
    wantsJson: false,
  };
}

/** Only a same-origin path is ever followed. An absolute URL here is an open redirect. */
function safeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

/*
 * RELATIVE, like every other redirect in this app. This one was missed when the rest were converted
 * on 2026-09-16, and it is the worst one to miss: the SUCCESS path already used seeOther, so signing
 * in worked and only a WRONG PASSWORD threw the browser at http://0.0.0.0:3000/login - the
 * container's bind address, which is not a site. Someone mistyping a password on the demo laptop met
 * "This site can't be reached" instead of "that password was not accepted".
 *
 * `request` is no longer needed to build the destination, which is the point: nothing here has to
 * know the name the browser used to reach it.
 */
function fail(_request: NextRequest, wantsJson: boolean, reason: string, next: string) {
  if (wantsJson) {
    return NextResponse.json({ ok: false, error: reason }, { status: 401 });
  }
  return seeOther(pathWithQuery('/login', { error: reason, next: safeNext(next) }));
}

export async function POST(request: NextRequest) {
  const ctx = requestContext(request.headers);
  let creds;
  try {
    creds = await readCredentials(request);
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  const { username, password, wantsJson } = creds;
  const next = safeNext(creds.next);

  if (!username || !password) return fail(request, wantsJson, 'missing', next);

  let row: CandidateRow | null;
  try {
    row = await queryOne<CandidateRow>(CANDIDATE_SQL, [username, password]);
  } catch (err) {
    console.error('[auth] credential check failed', err);
    return fail(request, wantsJson, 'unavailable', next);
  }

  // One audit row per outcome, with the attempted username as text. The account may not exist, so
  // there is no actor id to record - the label is what makes a brute-force run visible in the log.
  const actor = { userId: row?.id ?? null, label: username };

  if (!row || !row.password_ok || row.is_locked) {
    if (row && !row.password_ok) {
      const max = await settingInt('auth.max_failed_logins', 8);
      const minutes = await settingInt('auth.lockout_minutes', 15);
      await query(
        `UPDATE users
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= $2
                                    THEN now() + make_interval(mins => $3)
                                    ELSE locked_until END
          WHERE id = $1`,
        [row.id, max, minutes],
      );
    }
    await audit(
      {
        action: AUDIT_ACTIONS.authLoginFailed,
        entityTable: 'users',
        entityId: row?.id ?? null,
        details: { username, reason: row?.is_locked ? 'locked' : 'invalid' },
      },
      actor,
      ctx,
    );
    return fail(request, wantsJson, row?.is_locked ? 'locked' : 'invalid', next);
  }

  await query(
    `UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`,
    [row.id],
  );
  await audit(
    { action: AUDIT_ACTIONS.authLoginSuccess, entityTable: 'users', entityId: row.id },
    actor,
    ctx,
  );

  const cookie = issueSessionCookie(row.id);
  const destination = row.must_change_password ? '/change-password' : next;
  const response = wantsJson
    ? NextResponse.json({ ok: true, next: destination })
    : seeOther(destination);

  response.cookies.set({
    name: cookie.name,
    value: cookie.value,
    maxAge: cookie.maxAge,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
  return response;
}
