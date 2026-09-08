import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { queryOne } from './db';

/**
 * session.ts - reads and verifies the session cookie, and hydrates the acting identity.
 *
 * SERVER ONLY.
 *
 * The cookie carries a user id, an issue time and a signature. It carries NO roles, NO capabilities
 * and NO person id. Everything that authorisation depends on is re-read from the database on every
 * request, so that an administrator's edit takes effect immediately instead of on the user's next
 * login - and so that a forged or stale cookie cannot assert a role it was never granted.
 *
 * The signature is an HMAC, not "the secret concatenated and base64-encoded". Concatenation makes
 * the secret recoverable from any single cookie the moment one leaks into a log.
 *
 * ENVIRONMENT VARIABLE NAMES COME FROM .env.example AND NOWHERE ELSE: SESSION_SECRET,
 * SESSION_TTL_SECONDS, SESSION_COOKIE_NAME. The lifetime is in SECONDS because that is the unit
 * .env.example and the compose files carry, and because a cookie's own max-age is in seconds - a
 * days-denominated variable had to be multiplied at two call sites, and one of them is where a
 * unit conversion goes wrong.
 */

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'tms_session';
/** 12 hours, matching the shipped value in .env.example. */
const DEFAULT_TTL_SECONDS = 43_200;

/** The configured lifetime in seconds. Falls back rather than throwing: a session that cannot be
 *  issued is an outage, and an unset optional variable is not a misconfiguration. */
function ttlSeconds(): number {
  const raw = Number(process.env.SESSION_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_SECONDS;
}

export interface SessionPayload {
  userId: string;
  issuedAt: number;
}

export interface Session {
  userId: string;
  username: string;
  personId: string | null;
  externalId: string | null;
  fullName: string | null;
  roles: string[];
  orgUnitIds: (string | null)[];
  mustChangePassword: boolean;
  issuedAt: number;
}

interface SessionRow {
  user_id: string;
  username: string;
  person_id: string | null;
  external_id: string | null;
  full_name: string | null;
  must_change_password: boolean;
  roles: string[] | null;
  org_unit_ids: (string | null)[] | null;
}

function secret(): Buffer {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET is missing or shorter than 32 characters.');
  }
  return Buffer.from(value, 'utf8');
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Builds a cookie value. The caller sets it with httpOnly, sameSite lax and secure in production. */
export function issueSessionCookie(userId: string): { name: string; value: string; maxAge: number } {
  const payload: SessionPayload = { userId, issuedAt: Date.now() };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { name: COOKIE_NAME, value: `${body}.${sign(body)}`, maxAge: ttlSeconds() };
}

/** Verifies signature and age. Returns null on anything unexpected; never throws on bad input. */
export function verifySessionCookie(raw: string | undefined): SessionPayload | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!safeEqual(mac, sign(body))) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload?.userId !== 'string' || typeof payload?.issuedAt !== 'number') return null;

  if (Date.now() - payload.issuedAt > ttlSeconds() * 1_000) return null;
  return payload;
}

const SESSION_SQL = `
  SELECT u.id            AS user_id,
         u.username::text AS username,
         u.person_id,
         p.external_id,
         p.full_name,
         u.must_change_password,
         COALESCE(array_agg(ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL), '{}'::text[]) AS roles,
         COALESCE(array_agg(ur.org_unit_id) FILTER (WHERE ur.role_code IS NOT NULL), '{}'::uuid[]) AS org_unit_ids
    FROM users u
    LEFT JOIN people p ON p.id = u.person_id AND p.deleted_at IS NULL
    LEFT JOIN user_roles ur
           ON ur.user_id = u.id
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
   WHERE u.id = $1
     AND u.is_active
     AND u.deleted_at IS NULL
   GROUP BY u.id, u.username, u.person_id, p.external_id, p.full_name, u.must_change_password
`;

/**
 * The acting identity for this request. Returns null for an absent, invalid, expired or
 * deactivated session. Caches nothing: a deactivated account loses access on its next request,
 * not on its next login.
 */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const payload = verifySessionCookie(jar.get(COOKIE_NAME)?.value);
  if (!payload) return null;

  const row = await queryOne<SessionRow>(SESSION_SQL, [payload.userId]);
  if (!row) return null;

  return {
    userId: row.user_id,
    username: row.username,
    personId: row.person_id,
    externalId: row.external_id,
    fullName: row.full_name,
    roles: row.roles ?? [],
    orgUnitIds: row.org_unit_ids ?? [],
    mustChangePassword: row.must_change_password,
    issuedAt: payload.issuedAt,
  };
}

/** For route handlers that must have a session. Throws a 401-shaped error rather than returning null. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    const err = new Error('Not authenticated') as Error & { status?: number };
    err.status = 401;
    throw err;
  }
  return session;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
