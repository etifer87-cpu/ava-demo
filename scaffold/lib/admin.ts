import 'server-only';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { query } from './db';

/**
 * lib/admin.ts - shared pieces of the administration module: the account directory query, role
 * grant shapes, temporary-password generation, and the one-time flash used to hand a generated
 * password to the screen without ever putting it in a URL.
 *
 * WHY A FLASH COOKIE. A reset password must be shown to the administrator exactly once. A redirect
 * with the password in the query string writes it into browser history, proxy logs and the audit
 * request line; rendering it from the POST handler loses the app shell. So the handler sets a
 * short-lived httpOnly cookie and redirects; the page reads it once and lets it expire. The cookie
 * lives FLASH_MAX_AGE seconds; a page load after that shows nothing, and the administrator resets
 * again. The value never touches the audit log.
 */

export const FLASH_COOKIE = 'ava_flash';
export const FLASH_MAX_AGE = 90;

export interface Flash {
  kind: 'ok' | 'warn' | 'bad';
  message: string;
  /** Shown once in a copyable block. Never logged. */
  secret?: string;
  secretLabel?: string;
}

export function flashCookie(flash: Flash, path = '/admin'): { name: string; value: string; maxAge: number; httpOnly: true; sameSite: 'lax'; secure: boolean; path: string } {
  return {
    name: FLASH_COOKIE,
    value: Buffer.from(JSON.stringify(flash), 'utf8').toString('base64url'),
    maxAge: FLASH_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path,
  };
}

export async function readFlash(): Promise<Flash | null> {
  const jar = await cookies();
  const raw = jar.get(FLASH_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Flash;
    return parsed && typeof parsed.message === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A temporary password: 16 characters from an unambiguous alphabet (no 0/O, 1/l/I), grouped for
 * reading aloud. Entropy ~ 80 bits. The account is created with must_change_password = true, so
 * this value lives until the first sign-in and no longer.
 */
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length] ?? 'x';
    if (i === 3 || i === 7 || i === 11) out += '-';
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Account directory                                                    */
/* ------------------------------------------------------------------ */

export interface GrantRow {
  role_code: string;
  role_name: string;
  org_unit_code: string | null;
  asset_class_code: string | null;
  expires_at: string | null;
}

export interface AccountRow {
  id: string;
  username: string;
  email: string | null;
  is_active: boolean;
  must_change_password: boolean;
  locked: boolean;
  created_at: string;
  last_login_at: string | null;
  person_id: string | null;
  external_id: string | null;
  full_name: string | null;
  position: string | null;
  instructor_role: string | null;
  instructor_roles: string[];
  seniority_number: number | null;
  org_unit: string | null;
  asset_class: string | null;
  org_unit_id: string | null;
  asset_class_id: string | null;
  grants: GrantRow[];
}

const ACCOUNTS_SQL = `
  SELECT u.id, u.username, u.email, u.is_active, u.must_change_password,
         (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
         u.created_at::text AS created_at,
         (SELECT max(a.occurred_at)::text FROM audit_log a
           WHERE a.actor_user_id = u.id AND a.action = 'auth.login.success') AS last_login_at,
         p.id AS person_id, p.external_id, p.full_name, p.position, p.instructor_role,
         COALESCE(p.instructor_roles, '{}') AS instructor_roles, p.seniority_number,
         ou.name AS org_unit, ac.name AS asset_class, p.org_unit_id, p.asset_class_id,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'role_code', ur.role_code,
                    'role_name', r.name,
                    'org_unit_code', gou.code,
                    'asset_class_code', gac.code,
                    'expires_at', ur.expires_at::text)
                  ORDER BY r.position, gac.code NULLS FIRST)
             FROM user_roles ur
             JOIN roles r ON r.code = ur.role_code
             LEFT JOIN org_units gou ON gou.id = ur.org_unit_id
             LEFT JOIN asset_classes gac ON gac.id = ur.asset_class_id
            WHERE ur.user_id = u.id
              AND (ur.expires_at IS NULL OR ur.expires_at > now())
         ), '[]'::json) AS grants
    FROM users u
    LEFT JOIN people p         ON p.id = u.person_id
    LEFT JOIN org_units ou     ON ou.id = p.org_unit_id
    LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
   WHERE u.deleted_at IS NULL
`;

export async function listAccounts(opts: {
  q?: string;
  role?: string;
  status?: 'active' | 'inactive' | '';
  fleet?: string;
}): Promise<AccountRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status === 'active') where.push('u.is_active');
  if (opts.status === 'inactive') where.push('NOT u.is_active');
  if (opts.q) {
    params.push(`%${opts.q}%`);
    where.push(`(u.username ILIKE $${params.length} OR p.full_name ILIKE $${params.length} OR p.external_id ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  if (opts.role) {
    params.push(opts.role);
    where.push(`EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role_code = $${params.length})`);
  }
  if (opts.fleet) {
    params.push(opts.fleet);
    where.push(`(ac.code = $${params.length} OR EXISTS (SELECT 1 FROM user_roles x JOIN asset_classes y ON y.id = x.asset_class_id WHERE x.user_id = u.id AND y.code = $${params.length}))`);
  }
  const sql = `${ACCOUNTS_SQL}${where.length ? ` AND ${where.join(' AND ')}` : ''} ORDER BY u.is_active DESC, COALESCE(p.full_name, u.username) LIMIT 500`;
  return query<AccountRow>(sql, params);
}

export async function getAccount(id: string): Promise<AccountRow | null> {
  const rows = await query<AccountRow>(`${ACCOUNTS_SQL} AND u.id = $1::uuid`, [id]);
  return rows[0] ?? null;
}

export interface RoleSummary {
  code: string;
  name: string;
  module: string;
  description: string;
  position: number;
  user_count: number;
  users: { id: string; username: string; full_name: string | null; is_active: boolean; binding: string | null }[];
}

/** Every role with its active holders - the admin hub's roles grid and its per-role popup. */
export async function roleSummaries(): Promise<RoleSummary[]> {
  return query<RoleSummary>(`
    SELECT r.code, r.name, r.module, r.description, r.position,
           count(DISTINCT ur.user_id)::int AS user_count,
           COALESCE((
             SELECT json_agg(json_build_object(
                      'id', u.id, 'username', u.username, 'full_name', p.full_name,
                      'is_active', u.is_active,
                      'binding', NULLIF(concat_ws(' · ', ac.code, ou.code), ''))
                    ORDER BY u.is_active DESC, COALESCE(p.full_name, u.username))
               FROM user_roles x
               JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL
               LEFT JOIN people p ON p.id = u.person_id
               LEFT JOIN asset_classes ac ON ac.id = x.asset_class_id
               LEFT JOIN org_units ou ON ou.id = x.org_unit_id
              WHERE x.role_code = r.code AND (x.expires_at IS NULL OR x.expires_at > now())
           ), '[]'::json) AS users
      FROM roles r
      LEFT JOIN user_roles ur ON ur.role_code = r.code AND (ur.expires_at IS NULL OR ur.expires_at > now())
      LEFT JOIN users uu ON uu.id = ur.user_id AND uu.deleted_at IS NULL
     GROUP BY r.code
     ORDER BY r.position, r.code
  `);
}

export interface Option { value: string; label: string }

export async function orgUnitOptions(): Promise<Option[]> {
  return query<Option>(`SELECT id AS value, concat(code, ' - ', name) AS label FROM org_units WHERE deleted_at IS NULL AND is_active ORDER BY position, code`);
}
export async function assetClassOptions(): Promise<Option[]> {
  return query<Option>(`SELECT id AS value, concat(code, ' - ', name) AS label FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'aircraft' ORDER BY position, code`);
}
export async function roleOptions(): Promise<(Option & { module: string })[]> {
  return query<Option & { module: string }>(`SELECT code AS value, name AS label, module FROM roles WHERE code <> 'planner' ORDER BY position, code`);
}

/* ------------------------------------------------------------------ the directory: people and their accounts */

/**
 * One row per PERSON on the roster, with the account that belongs to them when there is one, plus
 * the accounts that have no roster row (administrators, service accounts) at the end. This is what
 * the Users page lists: an administrator manages people first and logins second, and "this pilot
 * has no account yet" is a state that must be visible, not an absence.
 */
export interface DirectoryRow {
  person_id: string | null;
  seniority_number: number | null;
  external_id: string | null;
  full_name: string | null;
  position: string | null;
  fleet: string | null;
  base: string | null;
  instructor_roles: string[];
  roster_status: string | null;
  user_id: string | null;
  username: string | null;
  user_active: boolean | null;
  locked: boolean | null;
  must_change_password: boolean | null;
  grants: GrantRow[];
  total: string;
}

export async function listDirectory(opts: { q?: string; role?: string; fleet?: string; position?: string; account?: 'yes' | 'no' | ''; qual?: string; status?: string }, page: number, size: number): Promise<DirectoryRow[]> {
  const where: string[] = ['(p.id IS NOT NULL OR u.id IS NOT NULL)'];
  const params: unknown[] = [];
  const status = opts.status ?? 'active';
  if (status === 'active') where.push(`(p.roster_status = 'active' OR (p.id IS NULL AND u.is_active))`);
  else if (status) { params.push(status); where.push(`p.roster_status = $${params.length}`); }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    where.push(`(p.full_name ILIKE $${params.length} OR p.external_id ILIKE $${params.length} OR u.username ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  if (opts.role) { params.push(opts.role); where.push(`EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role_code = $${params.length})`); }
  if (opts.fleet) { params.push(opts.fleet); where.push(`ac.code = $${params.length}`); }
  if (opts.position) { params.push(opts.position); where.push(`p.position = $${params.length}`); }
  if (opts.qual === 'any') where.push(`cardinality(p.instructor_roles) > 0`);
  else if (opts.qual) { params.push(opts.qual); where.push(`$${params.length} = ANY(p.instructor_roles)`); }
  if (opts.account === 'yes') where.push('u.id IS NOT NULL');
  if (opts.account === 'no') where.push('u.id IS NULL');
  return query<DirectoryRow>(`
    SELECT p.id AS person_id, p.seniority_number, p.external_id, p.full_name, p.position, ac.code AS fleet, ou.code AS base,
           COALESCE(p.instructor_roles, '{}') AS instructor_roles, p.roster_status,
           u.id AS user_id, u.username, u.is_active AS user_active,
           (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked, u.must_change_password,
           COALESCE((
             SELECT json_agg(json_build_object('role_code', ur.role_code, 'role_name', r.name, 'org_unit_code', gou.code, 'asset_class_code', gac.code, 'expires_at', ur.expires_at::text) ORDER BY r.position, gac.code NULLS FIRST)
               FROM user_roles ur JOIN roles r ON r.code = ur.role_code
               LEFT JOIN org_units gou ON gou.id = ur.org_unit_id LEFT JOIN asset_classes gac ON gac.id = ur.asset_class_id
              WHERE ur.user_id = u.id AND (ur.expires_at IS NULL OR ur.expires_at > now())), '[]'::json) AS grants,
           count(*) OVER ()::text AS total
      FROM people p
      FULL OUTER JOIN users u ON u.person_id = p.id AND u.deleted_at IS NULL
      LEFT JOIN org_units ou ON ou.id = p.org_unit_id
      LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
     WHERE (p.id IS NULL OR p.deleted_at IS NULL) AND ${where.join(' AND ')}
     ORDER BY p.seniority_number NULLS LAST, p.external_id NULLS LAST, u.username
     LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
}

export interface PersonHead { id: string; external_id: string; full_name: string; position: string | null; asset_class_id: string | null; org_unit_id: string | null; fleet: string | null; base: string | null; instructor_role: string | null; instructor_roles: string[]; joined_on: string | null; has_user: boolean }

export async function getPerson(id: string): Promise<PersonHead | null> {
  const rows = await query<PersonHead>(`
    SELECT p.id, p.external_id, p.full_name, p.position, p.asset_class_id, p.org_unit_id, ac.code AS fleet, ou.code AS base, p.instructor_role,
           COALESCE(p.instructor_roles, '{}') AS instructor_roles, p.joined_on::text,
           EXISTS (SELECT 1 FROM users u WHERE u.person_id = p.id AND u.deleted_at IS NULL) AS has_user
      FROM people p LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id LEFT JOIN org_units ou ON ou.id = p.org_unit_id
     WHERE p.id = $1::uuid AND p.deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
}

/** A username from a name - first initial and first surname, ASCII, lower - made unique with a number. */
export async function suggestUsername(fullName: string): Promise<string> {
  const parts = fullName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
  const base = parts.length >= 2 ? `${parts[0]![0]}.${parts[1]}` : parts[0] ?? 'user';
  const clean = base.replace(/[^a-z0-9._-]/g, '');
  const taken = new Set((await query<{ username: string }>(`SELECT username FROM users WHERE username LIKE $1 AND deleted_at IS NULL`, [`${clean}%`])).map((r) => r.username));
  if (!taken.has(clean)) return clean;
  for (let i = 2; i < 100; i += 1) if (!taken.has(`${clean}${i}`)) return `${clean}${i}`;
  return `${clean}${Date.now() % 1000}`;
}
