/**
 * permissions.ts - CLIENT-SAFE pure predicates.
 *
 * This module has no database access, no imports from `db.ts`, `session.ts` or `access.ts`, and no
 * `server-only` marker: it is meant to be imported into client components so a page can decide
 * WHAT TO RENDER.
 *
 * It is a convenience, never a control. Every server route re-checks with `access.ts`. The one
 * boundary worth a lint rule in this codebase is that `access.ts` is never imported from a client
 * component; a single accidental import ships the whole permission model and the connection string
 * with it.
 *
 * The rendering rule these predicates serve: a UI element the role lacks is NOT RENDERED. Not
 * disabled, not greyed out, not hidden with CSS. A disabled button tells the user the action
 * exists, tells an attacker where to look, and tempts the next developer to trust it in the handler.
 */

export type Scope = 'own' | 'assigned' | 'team' | 'org' | 'all';

/** What `/api/me/capabilities` returns: capability code -> the scopes held for it. */
export type CapabilityMap = Readonly<Record<string, readonly Scope[]>>;

export interface ClientSession {
  readonly userId: string;
  readonly personId: string | null;
  readonly roles: readonly string[];
  readonly capabilities: CapabilityMap;
}

const EMPTY: readonly Scope[] = Object.freeze([]);

/** The scopes held for a capability. Never throws; an unknown capability is simply no scopes. */
export function scopesFor(session: ClientSession | null, capability: string): readonly Scope[] {
  if (!session) return EMPTY;
  return session.capabilities[capability] ?? EMPTY;
}

/** Holds the capability at any scope at all. */
export function can(session: ClientSession | null, capability: string): boolean {
  return scopesFor(session, capability).length > 0;
}

/** Holds the capability at one of the named scopes. */
export function canAt(
  session: ClientSession | null,
  capability: string,
  ...scopes: readonly Scope[]
): boolean {
  const held = scopesFor(session, capability);
  return scopes.some((s) => held.includes(s));
}

/** Holds every one of the named capabilities. Use for a control that performs a compound action. */
export function canAll(session: ClientSession | null, ...capabilities: readonly string[]): boolean {
  return capabilities.every((c) => can(session, c));
}

/** Holds any one of the named capabilities. Use for a nav item that fronts several pages. */
export function canAny(session: ClientSession | null, ...capabilities: readonly string[]): boolean {
  return capabilities.some((c) => can(session, c));
}

export function hasRole(session: ClientSession | null, ...roles: readonly string[]): boolean {
  if (!session) return false;
  return roles.some((r) => session.roles.includes(r));
}

export function isSelf(session: ClientSession | null, personId: string | null | undefined): boolean {
  if (!session?.personId || !personId) return false;
  return session.personId === personId;
}

/**
 * Whether a control acting on one person's data should be rendered.
 *
 * `own` alone is satisfied only by the acting person's own row. Any wider scope renders the
 * control optimistically, and the SERVER decides whether the specific row is in reach - the client
 * cannot know the assigned or team member set, and must not pretend to.
 */
export function canTouchPerson(
  session: ClientSession | null,
  capability: string,
  personId: string | null | undefined,
): boolean {
  const held = scopesFor(session, capability);
  if (held.length === 0) return false;
  if (held.length === 1 && held[0] === 'own') return isSelf(session, personId);
  return true;
}

/**
 * Self-view exclusion, mirrored on the client purely so the link is not rendered.
 * The rule is enforced in `access.ts`; this copy only avoids showing a door that will not open.
 *
 * An assessor may not view their own grading analytics at any scope, including `all`. Those figures
 * measure leniency and deviation from the cohort; an assessor who can watch their own delta will
 * grade to the metric, and the metric stops measuring anything.
 */
export function canViewAssessorAnalytics(
  session: ClientSession | null,
  assessorPersonId: string | null | undefined,
): boolean {
  if (!can(session, 'training.analytics.assessor.view')) return false;
  return !isSelf(session, assessorPersonId);
}

/** A subject never requests their own analysis run: a run is a scheduled, auditable act. */
export function canRequestAnalysis(
  session: ClientSession | null,
  subjectPersonId: string | null | undefined,
): boolean {
  const held = scopesFor(session, 'training.analysis.run');
  if (held.length === 0) return false;
  if (held.includes('own') && held.length === 1) return false;
  return canTouchPerson(session, 'training.analysis.run', subjectPersonId);
}

/** Correcting one's own signed evidence without a second party is the finding that ends an audit. */
export function canAmendRecord(
  session: ClientSession | null,
  recordAssessorPersonId: string | null | undefined,
): boolean {
  if (!can(session, 'training.records.amend')) return false;
  return !isSelf(session, recordAssessorPersonId);
}

/** Which top-level modules to render in the navigation. */
export function visibleModules(session: ClientSession | null): string[] {
  const modules: string[] = [];
  if (canAny(session, 'training.sessions.view', 'training.records.view', 'training.templates.view')) {
    modules.push('training');
  }
  if (canAny(session, 'qms.qualifications.view', 'qms.approvals.decide', 'qms.events.view')) {
    modules.push('qms');
  }
  if (can(session, 'dms.documents.view')) modules.push('dms');
  if (can(session, 'planning.schedule.view')) modules.push('planning');
  if (canAny(session, 'platform.users.view', 'platform.audit.view', 'platform.settings.manage')) {
    modules.push('admin');
  }
  return modules;
}
