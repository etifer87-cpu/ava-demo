import { NextResponse, type NextRequest } from 'next/server';
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

async function readCredentials(request: NextRequest) {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      username: typeof body.username === 'string' ? body.username.trim() : '',
      password: typeof body.password === 'string' ? body.password : '',
      next: typeof body.next === 'string' ? body.next : '/',
      wantsJson: true,
    };
  }
  const form = await request.formData();
  return {
    username: String(form.get('username') ?? '').trim(),
    password: String(form.get('password') ?? ''),
    next: String(form.get('next') ?? '/'),
    wantsJson: false,
  };
}

/** Only a same-origin path is ever followed. An absolute URL here is an open redirect. */
function safeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function fail(request: NextRequest, wantsJson: boolean, reason: string, next: string) {
  if (wantsJson) {
    return NextResponse.json({ ok: false, error: reason }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?error=${reason}&next=${encodeURIComponent(safeNext(next))}`;
  return NextResponse.redirect(url, 303);
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
    : NextResponse.redirect(new URL(destination, request.nextUrl.origin), 303);

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
