import 'server-only';
import { query } from './db';
import type { CapabilityMap, Scope } from './permissions';
import type { Session } from './session';

/**
 * access.ts - the SERVER-ONLY capability resolver and the per-table read ACL.
 *
 * This is the authorisation boundary. The edge route guard filters; the client hides; only this
 * module decides. Every protected route handler calls `requireCapability` or `canOnRow` before it
 * touches data, on every request, with no cache that outlives the request.
 *
 * NEVER import this module from a client component. `server-only` above makes that a build error.
 */

export type { Scope } from './permissions';

const HARD_GATES_CACHE_MS = 60_000;

interface GrantRow {
  capability_code: string;
  scope: Scope;
  org_unit_id: string | null;
  is_overridable: boolean;
}

const GRANT_SQL = `
  SELECT rc.capability_code, rc.scope, ur.org_unit_id, c.is_overridable
    FROM user_roles ur
    JOIN role_capabilities rc ON rc.role_code = ur.role_code
    JOIN capabilities c       ON c.code = rc.capability_code
   WHERE ur.user_id = $1
     AND (ur.expires_at IS NULL OR ur.expires_at > now())
`;

export interface ResolvedAccess {
  readonly session: Session;
  /** capability -> the SET of scopes held. Never collapsed to a single widest scope. */
  readonly capabilities: CapabilityMap;
  /** capability -> the org units the grant was scoped to (null means every unit). */
  readonly grantOrgUnits: Readonly<Record<string, readonly (string | null)[]>>;
}

/**
 * Resolves the effective capability set from the database.
 *
 * The scopes are a SET, deliberately. `assigned` and `team` overlap without either containing the
 * other, so collapsing to "the widest" silently removes access from anyone holding one capability
 * at two non-nested scopes - the symptom is a user who can see a subject on one page and not on
 * another, and it reads as a caching bug for weeks.
 */
export async function resolveAccess(session: Session): Promise<ResolvedAccess> {
  const rows = await query<GrantRow>(GRANT_SQL, [session.userId]);

  const capabilities: Record<string, Scope[]> = {};
  const grantOrgUnits: Record<string, (string | null)[]> = {};

  for (const row of rows) {
    const scopes = (capabilities[row.capability_code] ??= []);
    if (!scopes.includes(row.scope)) scopes.push(row.scope);
    const units = (grantOrgUnits[row.capability_code] ??= []);
    if (!units.includes(row.org_unit_id)) units.push(row.org_unit_id);
  }

  return { session, capabilities, grantOrgUnits };
}

export function scopesFor(access: ResolvedAccess, capability: string): readonly Scope[] {
  return access.capabilities[capability] ?? [];
}

export function can(access: ResolvedAccess, capability: string): boolean {
  return scopesFor(access, capability).length > 0;
}

export function forbidden(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 403;
  return err;
}

/** Throws 403 unless the capability is held at some scope. The first line of every handler. */
export function requireCapability(access: ResolvedAccess, capability: string): void {
  if (!can(access, capability)) {
    throw forbidden(`Missing capability ${capability}`);
  }
}

/**
 * Hard gates. A capability with `is_overridable = false` may be conferred only by a role in the
 * published matrix, and is re-checked here after every other rule. The moment such a capability
 * becomes grantable by exception, someone grants it "temporarily" and it is still granted two
 * years later.
 */
let hardGates: Set<string> | null = null;
let hardGatesLoadedAt = 0;

export async function hardGatedCapabilities(): Promise<Set<string>> {
  if (hardGates && Date.now() - hardGatesLoadedAt < HARD_GATES_CACHE_MS) return hardGates;
  const rows = await query<{ code: string }>(
    'SELECT code FROM capabilities WHERE NOT is_overridable',
  );
  hardGates = new Set(rows.map((r) => r.code));
  hardGatesLoadedAt = Date.now();
  return hardGates;
}

/* ------------------------------------------------------------------ */
/* Scope member sets                                                    */
/* ------------------------------------------------------------------ */

/**
 * The subjects an assessor actually taught: the single seam for the `assigned` scope.
 * Derived here and nowhere else. A route that builds its own version of this filter will drift.
 */
const ASSIGNED_SQL = `
  SELECT DISTINCT ss.person_id
    FROM sessions s
    JOIN session_subjects ss ON ss.session_id = s.id
   WHERE s.deleted_at IS NULL
     AND (s.assessor_person_id = $1 OR s.second_assessor_person_id = $1)
`;

const TEAM_SQL = `
  SELECT p.id AS person_id
    FROM people p
   WHERE p.deleted_at IS NULL
     AND p.org_unit_id = ANY($1::uuid[])
`;

/** Every org unit at or below the given units. */
const ORG_SQL = `
  WITH RECURSIVE tree AS (
    SELECT id FROM org_units WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
    UNION ALL
    SELECT o.id FROM org_units o JOIN tree t ON o.parent_id = t.id WHERE o.deleted_at IS NULL
  )
  SELECT p.id AS person_id
    FROM people p
   WHERE p.deleted_at IS NULL
     AND p.org_unit_id IN (SELECT id FROM tree)
`;

/** A result meaning "no filter": the caller holds the capability at `all`. */
export const ALL_PEOPLE = Symbol('all_people');
export type VisiblePeople = typeof ALL_PEOPLE | Set<string>;

/**
 * The `people.id` set this caller may see for a capability, unioned across ALL held scopes.
 * Returns ALL_PEOPLE when an `all` grant exists, so the caller omits the filter entirely rather
 * than building a several-thousand-element IN list.
 */
export async function visiblePersonIds(
  access: ResolvedAccess,
  capability: string,
): Promise<VisiblePeople> {
  const scopes = scopesFor(access, capability);
  if (scopes.length === 0) return new Set<string>();
  if (scopes.includes('all')) return ALL_PEOPLE;

  const ids = new Set<string>();
  const { session } = access;

  if (scopes.includes('own') && session.personId) {
    ids.add(session.personId);
  }

  if (scopes.includes('assigned') && session.personId) {
    const rows = await query<{ person_id: string }>(ASSIGNED_SQL, [session.personId]);
    for (const r of rows) ids.add(r.person_id);
  }

  const units = (access.grantOrgUnits[capability] ?? []).filter((u): u is string => u !== null);

  if (scopes.includes('team') && units.length > 0) {
    const rows = await query<{ person_id: string }>(TEAM_SQL, [units]);
    for (const r of rows) ids.add(r.person_id);
  }

  if (scopes.includes('org') && units.length > 0) {
    const rows = await query<{ person_id: string }>(ORG_SQL, [units]);
    for (const r of rows) ids.add(r.person_id);
  }

  return applySelfExclusions(access, capability, ids);
}

/**
 * Self-view exclusions. These are exclusions, not scopes: `assigned`, `team`, `org` and `all` all
 * otherwise include the holder. Applied here so that a route which correctly asks the resolver
 * cannot get them wrong - which is why routes are not permitted to build their own filters.
 */
const SELF_EXCLUDED_CAPABILITIES = new Set<string>([
  // An assessor may not view their own grading analytics, at any scope including `all`.
  'training.analytics.assessor.view',
]);

function applySelfExclusions(
  access: ResolvedAccess,
  capability: string,
  ids: Set<string>,
): Set<string> {
  if (SELF_EXCLUDED_CAPABILITIES.has(capability) && access.session.personId) {
    ids.delete(access.session.personId);
  }
  return ids;
}

/** Whether one specific person's row is in reach. Handles ALL_PEOPLE and the exclusions. */
export async function canOnPerson(
  access: ResolvedAccess,
  capability: string,
  personId: string | null | undefined,
): Promise<boolean> {
  if (!personId) return false;
  if (SELF_EXCLUDED_CAPABILITIES.has(capability) && personId === access.session.personId) {
    return false;
  }
  const visible = await visiblePersonIds(access, capability);
  if (visible === ALL_PEOPLE) return true;
  return visible.has(personId);
}

/** Throws 403 rather than returning false. Use at the top of a handler acting on one person. */
export async function requireOnPerson(
  access: ResolvedAccess,
  capability: string,
  personId: string | null | undefined,
): Promise<void> {
  if (!(await canOnPerson(access, capability, personId))) {
    throw forbidden(`Not permitted: ${capability} on person ${personId ?? 'unknown'}`);
  }
}

/* ------------------------------------------------------------------ */
/* Table read ACL                                                       */
/* ------------------------------------------------------------------ */

/**
 * The generic tabular read endpoint is the most dangerous surface in the platform, so it is the
 * most narrowly described. A table is readable only when it appears here, the caller holds the
 * named capability, and - for a scoped entry - the rows are filtered to the caller's visible
 * person set BEFORE serialisation.
 *
 * A table absent from this map returns 403 to EVERY role, platform administrators included.
 * `users` is deliberately absent, and a live 403 on it is the deployment canary: a served prebuilt
 * bundle will happily keep enforcing the old rules, so if it returns rows, an old build is running.
 */
export interface TableAclEntry {
  readonly capability: string;
  /** The column holding a `people.id`, or null for an unscoped reference table. */
  readonly personColumn: string | null;
  /** Extra always-applied predicate, e.g. the soft-delete filter. */
  readonly baseFilter?: string;
}

export const TABLE_READ_ACL: Readonly<Record<string, TableAclEntry>> = Object.freeze({
  people:                { capability: 'people.view',              personColumn: 'id',         baseFilter: 'deleted_at IS NULL' },
  sessions:              { capability: 'training.sessions.view',   personColumn: null,         baseFilter: 'deleted_at IS NULL' },
  session_subjects:      { capability: 'training.sessions.view',   personColumn: 'person_id' },
  element_grades:        { capability: 'training.sessions.view',   personColumn: 'person_id' },
  competency_grades:     { capability: 'training.sessions.view',   personColumn: 'person_id' },
  records:               { capability: 'training.records.view',    personColumn: 'person_id',  baseFilter: 'deleted_at IS NULL' },
  record_tasks:          { capability: 'training.records.view',    personColumn: null },
  record_competencies:   { capability: 'training.records.view',    personColumn: null },
  line_sectors:          { capability: 'training.records.view',    personColumn: 'person_id',  baseFilter: 'deleted_at IS NULL' },
  analysis_runs:         { capability: 'training.analysis.view',   personColumn: 'person_id',  baseFilter: 'deleted_at IS NULL' },
  session_templates:     { capability: 'training.templates.view',  personColumn: null,         baseFilter: 'deleted_at IS NULL' },
  session_template_versions: { capability: 'training.templates.view', personColumn: null,      baseFilter: 'deleted_at IS NULL' },
  template_elements:     { capability: 'training.templates.view',  personColumn: null },
  template_competencies: { capability: 'training.templates.view',  personColumn: null },
  element_library:       { capability: 'training.library.manage',  personColumn: null,         baseFilter: 'deleted_at IS NULL' },
  competency_frameworks: { capability: 'training.templates.view',  personColumn: null },
  competencies:          { capability: 'training.templates.view',  personColumn: null },
  observable_behaviours: { capability: 'training.templates.view',  personColumn: null },
  org_units:             { capability: 'people.view',              personColumn: null,         baseFilter: 'deleted_at IS NULL' },
  asset_classes:         { capability: 'people.view',              personColumn: null,         baseFilter: 'deleted_at IS NULL' },
  audit_log:             { capability: 'platform.audit.view',      personColumn: null },
});

export interface TableReadPlan {
  readonly table: string;
  /** SQL predicate to append, already parameterised. */
  readonly where: string;
  readonly params: unknown[];
}

/**
 * Authorises a generic table read and returns the filter the caller MUST apply.
 * Throws 403 for an unlisted table or a missing capability.
 *
 * The person filter is passed as a single uuid[] parameter, never interpolated into the SQL. A
 * predecessor built the equivalent filter by joining hundreds of ids into a URL and hit an 18 KB
 * request that the server rejected outright; the page simply reported "failed to load" for months.
 */
export async function authorizeTableRead(
  access: ResolvedAccess,
  table: string,
): Promise<TableReadPlan> {
  const entry = TABLE_READ_ACL[table];
  if (!entry) {
    throw forbidden(`Table ${table} is not readable through this endpoint`);
  }
  requireCapability(access, entry.capability);

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (entry.baseFilter) clauses.push(entry.baseFilter);

  if (entry.personColumn) {
    const visible = await visiblePersonIds(access, entry.capability);
    if (visible !== ALL_PEOPLE) {
      if (visible.size === 0) {
        // Fail closed. An empty scope means no rows, never every row.
        clauses.push('false');
      } else {
        params.push([...visible]);
        clauses.push(`${entry.personColumn} = ANY($${params.length}::uuid[])`);
      }
    }
  }

  return { table, where: clauses.length ? clauses.join(' AND ') : 'true', params };
}

/**
 * The map a client receives from /api/me/capabilities. It is a rendering aid and nothing else -
 * every route re-resolves from the database regardless of what the client believes it holds.
 */
export function clientCapabilityMap(access: ResolvedAccess): CapabilityMap {
  return access.capabilities;
}
