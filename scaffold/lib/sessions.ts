import 'server-only';
import { query, queryOne } from '@/lib/db';
import { policy, templateKind, type TemplateKind } from '@/lib/config';
import { boundFleets, type ResolvedAccess } from '@/lib/access';
import { foldedLike, foldedLikeAny } from './search';

/**
 * lib/sessions.ts - the sessions a person may see, the programs they may open one against, and the
 * creation write. docs/04_ETR.md §2, §4.
 *
 * ELIGIBILITY IS DECIDED HERE, SERVER-SIDE, AND AGAIN ON THE WRITE. Three things narrow which
 * program an instructor may open a session against, and the form only ever mirrors them:
 *
 *   1. the version is PUBLISHED - a draft has no records and no immutability, so it cannot be flown;
 *   2. `session_template_versions.allowed_assessor_roles` - empty means any assessor role, a
 *      non-empty array must intersect the PLATFORM ROLE CODES this caller holds. Migration 0020
 *      says in as many words that this is re-validated server-side because "a client that omits it
 *      must not silently widen eligibility";
 *
 * TWO VOCABULARIES, AND THEY ARE NOT INTERCHANGEABLE. `allowed_assessor_roles` carries platform role
 * codes - `instructor`, `examiner`, `ground_instructor`, `assessment_manager`, the list in
 * policy.yaml `assessor_role_codes`. `people.instructor_roles` carries AVIATION QUALIFICATIONS - TRI,
 * TRE, SFI, LTC, CRMI, GI. A TRI holds the qualification and is granted the `instructor` role, and
 * matching one against the other silently opens nothing to anybody. Eligibility is decided by the
 * ROLE, which is what an administrator grants and revokes; the qualification is shown beside it
 * because it is what a head of training actually thinks in, but it grants nothing on its own.
 *   3. the fleet binding on the caller's grant - an A320-bound instructor is not offered a B787
 *      program. A program with no fleet (the LFUS sector, the line check) is offered to everyone,
 *      and takes its fleet from the pilot.
 *
 * The device is chosen HERE rather than in the program: one EBT module is flown in whichever
 * simulator is free, and binding a device into the program would mean a version per device.
 */

export type SessionStatus = 'in_progress' | 'submitted' | 'signed' | 'finalized' | 'void';

/** How a status reads on a screen. The lifecycle itself is docs/04 §2. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  in_progress: 'Open',
  submitted: 'Submitted',
  signed: 'Signed',
  finalized: 'Finalised',
  void: 'Void',
};
export const STATUS_TONE: Record<SessionStatus, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  in_progress: 'warn', submitted: 'info', signed: 'info', finalized: 'good', void: 'neutral',
};

export interface SessionRow {
  id: string;
  session_date: string;
  status: SessionStatus;
  facility: string | null;
  facility_kind: string | null;
  outcome: string | null;
  template_id: string;
  template_name: string;
  template_code: string;
  template_kind: string;
  kind_label: string;
  version_no: number;
  fleet: string | null;
  base: string | null;
  assessor_id: string | null;
  assessor_name: string | null;
  subjects: { person_id: string; full_name: string; position: string | null; seat_role: string; signed_at: string | null; outcome: string | null }[];
  check: string | null;
  sector_number: number | null;
  route: string | null;
  assessor_signed_at: string | null;
  record_count: number;
  total: number;
}

export interface SessionFilters { q: string; status: string; fleet: string; kind: string; mine: string }

const SELECT = `
  SELECT s.id, s.session_date::text AS session_date, s.status, s.facility, s.facility_kind, s.outcome,
         s.assessor_signed_at::text AS assessor_signed_at,
         t.id AS template_id, t.name AS template_name, t.code AS template_code, t.template_kind,
         COALESCE(k.label, t.template_kind) AS kind_label, v.version AS version_no,
         ac.code AS fleet, ou.code AS base,
         s.assessor_person_id AS assessor_id, ap.full_name AS assessor_name,
         s.setup->>'check' AS "check", (s.setup->>'sector_number')::int AS sector_number,
         CASE WHEN s.setup->>'departure' IS NULL THEN NULL
              ELSE (s.setup->>'departure') || ' - ' || COALESCE(s.setup->>'arrival', '?') END AS route,
         COALESCE((SELECT json_agg(json_build_object(
                     'person_id', ss.person_id, 'full_name', sp.full_name, 'position', sp.position,
                     'seat_role', ss.seat_role, 'signed_at', ss.subject_signed_at::text,
                     -- PER PILOT, from session_subjects. sessions.outcome is a different column and
                     -- nothing writes it: saveSessionFields has always written the outcome against the
                     -- pilot, because on a crewed session one pilot can pass and the other not.
                     -- (No backticks in here, ever: this SQL lives inside a template literal.)
                     'outcome', ss.outcome) ORDER BY ss.created_at)
                     FROM session_subjects ss JOIN people sp ON sp.id = ss.person_id
                    WHERE ss.session_id = s.id), '[]'::json) AS subjects,
         (SELECT count(*)::int FROM records r WHERE r.session_id = s.id AND r.deleted_at IS NULL) AS record_count,
         count(*) OVER ()::int AS total
    FROM sessions s
    JOIN session_template_versions v ON v.id = s.template_version_id
    JOIN session_templates t ON t.id = v.template_id
    LEFT JOIN template_kinds k ON k.code = t.template_kind
    LEFT JOIN asset_classes ac ON ac.id = s.asset_class_id
    LEFT JOIN org_units ou ON ou.id = s.org_unit_id
    LEFT JOIN people ap ON ap.id = s.assessor_person_id`;

/** Every session in reach, newest first. `mine` narrows to the caller's own as assessor. */
export async function listSessions(f: SessionFilters, access: ResolvedAccess, page: number, size: number): Promise<SessionRow[]> {
  const where = ['s.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (f.mine === '1' && access.session.personId) { params.push(access.session.personId); where.push(`s.assessor_person_id = $${params.length}::uuid`); }
  if (f.status) { params.push(f.status); where.push(`s.status = $${params.length}`); }
  if (f.kind) { params.push(f.kind); where.push(`t.template_kind = $${params.length}`); }
  if (f.fleet) { params.push(f.fleet); where.push(`ac.code = $${params.length}`); }
  if (f.q) {
    params.push(`%${f.q}%`);
    const p = `$${params.length}`;
    where.push(`(${foldedLikeAny(['t.name', 'ap.full_name'], p)}
                 OR EXISTS (SELECT 1 FROM session_subjects ss2 JOIN people sp2 ON sp2.id = ss2.person_id
                             WHERE ss2.session_id = s.id AND ${foldedLike('sp2.full_name', p)}))`);
  }
  const fleets = boundFleets(access, 'training.sessions.view');
  if (fleets) { params.push([...fleets]); where.push(`(s.asset_class_id = ANY($${params.length}::uuid[]) OR s.asset_class_id IS NULL)`); }
  return query<SessionRow>(`${SELECT} WHERE ${where.join(' AND ')}
     ORDER BY s.session_date DESC, s.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
}

export async function getSession(id: string): Promise<SessionRow | null> {
  return queryOne<SessionRow>(`${SELECT} WHERE s.deleted_at IS NULL AND s.id = $1::uuid`, [id]);
}

/** Counts per status for the caller's scope, so the tabs carry numbers and an empty tab is visible. */
export async function sessionCounts(f: SessionFilters, access: ResolvedAccess): Promise<Record<string, number>> {
  const where = ['s.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (f.mine === '1' && access.session.personId) { params.push(access.session.personId); where.push(`s.assessor_person_id = $${params.length}::uuid`); }
  const rows = await query<{ status: string; n: number }>(
    `SELECT s.status, count(*)::int AS n FROM sessions s WHERE ${where.join(' AND ')} GROUP BY 1`, params);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// ------------------------------------------------------------------ what may be opened, and against whom

export interface EligibleProgram {
  template_id: string; version_id: string; code: string; name: string; template_kind: string; kind_label: string;
  fleet: string | null; version_no: number; facility_kind: string | null;
  allowed_assessor_roles: string[]; hide_record_from_subject: boolean;
  check_options: string[] | null;
}

/** The platform role codes this user holds, unexpired. The vocabulary `allowed_assessor_roles` uses. */
export async function heldRoleCodes(userId: string): Promise<string[]> {
  const rows = await query<{ role_code: string }>(
    `SELECT DISTINCT ur.role_code FROM user_roles ur
      WHERE ur.user_id = $1::uuid AND (ur.expires_at IS NULL OR ur.expires_at > now())`, [userId]);
  return rows.map((r) => r.role_code);
}

/**
 * The published programs this caller may open a session against. `roleCodes` are the PLATFORM roles
 * they hold (see the module docstring); a caller holding none is offered only programs that name no
 * role at all.
 */
export async function eligiblePrograms(access: ResolvedAccess, roleCodes: readonly string[]): Promise<EligibleProgram[]> {
  const fleets = boundFleets(access, 'training.sessions.create');
  const params: unknown[] = [[...roleCodes]];
  let fleetClause = '';
  if (fleets) { params.push([...fleets]); fleetClause = `AND (t.asset_class_id = ANY($${params.length}::uuid[]) OR t.asset_class_id IS NULL)`; }
  const rows = await query<EligibleProgram & { check_options: string[] | null }>(`
    SELECT t.id AS template_id, v.id AS version_id, t.code, t.name, t.template_kind,
           COALESCE(k.label, t.template_kind) AS kind_label, ac.code AS fleet, v.version AS version_no,
           k.facility_kind, v.allowed_assessor_roles, v.hide_record_from_subject
      FROM session_templates t
      JOIN session_template_versions v ON v.id = t.current_version_id AND v.status = 'published'
      LEFT JOIN template_kinds k ON k.code = t.template_kind
      LEFT JOIN asset_classes ac ON ac.id = t.asset_class_id
     WHERE t.deleted_at IS NULL AND t.is_active
       AND ( cardinality(v.allowed_assessor_roles) = 0 OR v.allowed_assessor_roles && $1::text[] )
       ${fleetClause}
     ORDER BY t.template_kind, t.code`, params);
  const P = policy();
  return rows.map((r) => ({ ...r, check_options: templateKind(r.template_kind, P)?.check_options ?? null }));
}

export interface SubjectOption { id: string; full_name: string; position: string | null; external_id: string; seniority_number: number | null; fleet: string | null; base: string | null }

/** The pilots this caller may put in a session, narrowed by the program's fleet when it has one. */
export async function subjectOptions(visible: Set<string> | null, fleet: string | null, q: string, limit = 40): Promise<SubjectOption[]> {
  const where = ["p.deleted_at IS NULL AND p.roster_status = 'active'"];
  const params: unknown[] = [];
  if (visible) { if (visible.size === 0) where.push('false'); else { params.push([...visible]); where.push(`p.id = ANY($${params.length}::uuid[])`); } }
  if (fleet) { params.push(fleet); where.push(`ac.code = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(${foldedLikeAny(['p.full_name', 'p.external_id'], `$${params.length}`)} OR p.seniority_number::text = $${params.length})`); }
  return query<SubjectOption>(`
    SELECT p.id, p.full_name, p.position, p.external_id, p.seniority_number, ac.code AS fleet, ou.code AS base
      FROM people p
      LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
      LEFT JOIN org_units ou ON ou.id = p.org_unit_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.seniority_number NULLS LAST LIMIT ${limit}`, params);
}

/** Simulators and other devices, for the facility choice on a device-based session. */
export async function deviceOptions(): Promise<{ code: string; name: string; category: string }[]> {
  return query<{ code: string; name: string; category: string }>(
    `SELECT code, name, category FROM asset_classes
      WHERE deleted_at IS NULL AND is_active AND category <> 'aircraft' ORDER BY position`);
}

// ------------------------------------------------------------------------------------ the write

export interface CreateInput {
  version_id: string;
  subject_id: string;
  seat_role: string;
  /**
   * The second seat, or null. A crewed session is ONE session with TWO subject rows, each graded
   * and signed and frozen separately - not two sessions, because the exercises were flown once and
   * the analytics must not count the detail twice.
   */
  subject_id_2?: string | null;
  seat_role_2?: string | null;
  session_date: string;
  device: string | null;
  facility: string | null;
  check: string | null;
  departure: string | null;
  arrival: string | null;
  registration: string | null;
  sector_number: number | null;
}

export class CreateRefused extends Error {}

/**
 * Creates one session, in one transaction, with every eligibility rule re-checked against the
 * database rather than against what the form sent.
 *
 * Single subject for now: the grading surface grades one pilot with a seat role, which covers a line
 * check, an LFUS sector and a single-pilot EBT module. A crew session writes two records from one
 * event and needs a subject switcher in the grading screen; `session_subjects` already carries N, so
 * that is an addition here rather than a change.
 */
export async function createSession(
  input: CreateInput,
  actor: { personId: string | null; userId: string; roleCodes: readonly string[] },
  access: ResolvedAccess,
): Promise<string> {
  const P = policy();
  if (!actor.personId) throw new CreateRefused('Your account is not linked to a roster row, so it cannot be the assessor on a session.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.session_date)) throw new CreateRefused('That is not a date.');
  if (!P.seats.subject_roles.includes(input.seat_role)) throw new CreateRefused('That seat role is not in the operator vocabulary.');

  const version = await queryOne<{
    version_id: string; template_id: string; template_kind: string; version_no: number; status: string;
    allowed_assessor_roles: string[]; fleet_code: string | null; asset_class_id: string | null; facility_kind: string | null;
  }>(`SELECT v.id AS version_id, t.id AS template_id, t.template_kind, v.version AS version_no, v.status,
             v.allowed_assessor_roles, ac.code AS fleet_code, t.asset_class_id, k.facility_kind
        FROM session_template_versions v
        JOIN session_templates t ON t.id = v.template_id
        LEFT JOIN template_kinds k ON k.code = t.template_kind
        LEFT JOIN asset_classes ac ON ac.id = t.asset_class_id
       WHERE v.id = $1::uuid AND t.deleted_at IS NULL AND t.is_active`, [input.version_id]);
  if (!version) throw new CreateRefused('That program does not exist.');
  if (version.status !== 'published') throw new CreateRefused('That version is a draft. A session can only be flown against a published program.');

  // Rule 2 of the module docstring, re-validated here and not taken from the form.
  const allowed = version.allowed_assessor_roles ?? [];
  if (allowed.length > 0 && !allowed.some((r) => actor.roleCodes.includes(r))) {
    const names = await query<{ code: string; name: string }>(`SELECT code, name FROM roles WHERE code = ANY($1::text[]) ORDER BY name`, [allowed]);
    const label = names.length ? names.map((n) => n.name).join(', ') : allowed.join(', ');
    throw new CreateRefused(`This program may only be conducted by ${label}. Your account holds ${actor.roleCodes.length ? actor.roleCodes.join(', ') : 'no role'}.`);
  }
  const fleets = boundFleets(access, 'training.sessions.create');
  if (fleets && version.asset_class_id && !fleets.includes(version.asset_class_id)) {
    // The message names fleets, not the ids the grant carries.
    const bound = await query<{ code: string }>(`SELECT code FROM asset_classes WHERE id = ANY($1::uuid[]) ORDER BY position`, [[...fleets]]);
    throw new CreateRefused(`Your grant is bound to ${bound.map((b) => b.code).join(', ') || 'no fleet'}, and this program is ${version.fleet_code ?? 'on another fleet'}.`);
  }

  const kind: TemplateKind | null = templateKind(version.template_kind, P);
  const checks = kind?.check_options ?? null;
  if (checks && !(input.check && checks.includes(input.check))) throw new CreateRefused(`Say which check this is: ${checks.join(' or ')}.`);
  if (!checks && input.check) throw new CreateRefused('This program is not a check.');

  type SubjectRow = { id: string; asset_class_id: string | null; org_unit_id: string | null; full_name: string; fleet_code: string | null };
  const loadSubject = async (personId: string): Promise<SubjectRow> => {
    const row = await queryOne<SubjectRow>(
      `SELECT p.id, p.asset_class_id, p.org_unit_id, p.full_name, ac.code AS fleet_code
         FROM people p LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
        WHERE p.id = $1::uuid AND p.deleted_at IS NULL AND p.roster_status = 'active'`, [personId]);
    if (!row) throw new CreateRefused('That pilot is not on the active roster.');
    if (row.id === actor.personId) throw new CreateRefused('An instructor cannot grade themselves.');
    if (version.fleet_code && row.fleet_code && version.fleet_code !== row.fleet_code) {
      throw new CreateRefused(`${row.full_name} is on ${row.fleet_code} and this is an ${version.fleet_code} program.`);
    }
    return row;
  };
  const subject = await loadSubject(input.subject_id);

  // THE SECOND SEAT. Every rule the first pilot passed is applied again, from the database, because
  // the form is a mirror of the rules and never their enforcement - and because a crewed session
  // produces a second signed record, which is not the place to discover a roster problem.
  const seat2 = (input.seat_role_2 ?? '').trim();
  const subject2 = input.subject_id_2?.trim()
    ? await loadSubject(input.subject_id_2.trim())
    : null;
  if (subject2) {
    if (subject2.id === subject.id) throw new CreateRefused('The same pilot cannot fly both seats.');
    if (!seat2) throw new CreateRefused('Say which seat the second pilot flew.');
    if (!P.seats.subject_roles.includes(seat2)) throw new CreateRefused('That seat role is not in the operator vocabulary.');
    if (seat2 === input.seat_role) throw new CreateRefused(`Both pilots cannot be ${seat2}. One flies, the other monitors.`);
  } else if (seat2) {
    throw new CreateRefused('A second seat was given with no second pilot.');
  }

  const facilityKind = version.facility_kind ?? 'other';
  const needsDevice = facilityKind === 'ffs' || facilityKind === 'ftd';
  if (needsDevice && !input.device) throw new CreateRefused('Choose the device this session is flown in.');
  if (input.device) {
    const dev = await queryOne<{ code: string }>(
      `SELECT code FROM asset_classes WHERE code = $1 AND deleted_at IS NULL AND is_active AND category <> 'aircraft'`, [input.device]);
    if (!dev) throw new CreateRefused('That device is not in the operator context.');
  }
  const isLine = facilityKind === 'line' || facilityKind === 'aircraft';
  if (isLine && (!input.departure || !input.arrival)) throw new CreateRefused('A line session needs a departure and an arrival.');
  if (input.sector_number !== null && input.sector_number < 1) throw new CreateRefused('A sector number starts at 1.');

  const framework = await queryOne<{ id: string }>(`SELECT id FROM competency_frameworks WHERE is_active LIMIT 1`);

  // The asset class on a session is a FROZEN copy and the analytics read it: the program's fleet when
  // it has one, otherwise the pilot's current fleet (docs/04 §4 - a line check often has none).
  const assetClassId = version.asset_class_id ?? subject.asset_class_id;
  const facility = input.facility?.trim() || (needsDevice ? input.device : isLine ? 'Line' : null);
  const setup: Record<string, unknown> = {
    created_on_screen: true,
    ...(input.device ? { device: input.device } : {}),
    ...(input.check ? { check: input.check } : {}),
    ...(isLine ? { departure: input.departure, arrival: input.arrival, aircraft_type: version.fleet_code ?? subject.fleet_code ?? null, registration: input.registration || null } : {}),
    ...(input.sector_number ? { sector_number: input.sector_number } : {}),
  };

  const row = await queryOne<{ id: string }>(
    `INSERT INTO sessions (template_version_id, framework_id, org_unit_id, asset_class_id, session_date, facility, facility_kind,
                           assessor_person_id, status, setup, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6, $7, $8::uuid, 'in_progress', $9::jsonb, $10::uuid)
     RETURNING id`,
    [input.version_id, framework?.id ?? null, subject.org_unit_id, assetClassId, input.session_date, facility, facilityKind,
     actor.personId, JSON.stringify(setup), actor.userId]);
  const id = row?.id;
  if (!id) throw new CreateRefused('The session could not be created.');
  await query(
    `INSERT INTO session_subjects (session_id, person_id, seat_role, is_assessed) VALUES ($1::uuid, $2::uuid, $3, true)`,
    [id, subject.id, input.seat_role]);
  if (subject2) {
    await query(
      `INSERT INTO session_subjects (session_id, person_id, seat_role, is_assessed) VALUES ($1::uuid, $2::uuid, $3, true)`,
      [id, subject2.id, seat2]);
  }
  return id;
}
