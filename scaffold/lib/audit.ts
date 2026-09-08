import 'server-only';
import type { PoolClient } from 'pg';
import { query } from './db';
import type { Session } from './session';

/**
 * audit.ts - the append-only audit writer.
 *
 * SERVER ONLY. `audit_log` carries a trigger that raises on UPDATE and DELETE and a REVOKE against
 * PUBLIC, so this module is the only way a row enters it and nothing is the way a row leaves it.
 * Append-only by convention is not append-only: the first data-fix script to touch the table
 * removes the evidence it was there to preserve.
 *
 * Writes are BEST EFFORT. A failed audit write is logged to the console and never blocks the action
 * it describes - an audit trail that can take the platform down is an availability liability, and
 * an action that silently did not happen because its log failed is worse than an unlogged action.
 * The compensating control is that the failure is loud in the process log and alertable.
 */

export interface AuditEntry {
  /** Dotted action, e.g. `record.delete`, `session.finalize`, `auth.login.failed`. */
  action: string;
  /** The table the entity lives in, where there is one. */
  entityTable?: string | null;
  entityId?: string | null;
  /** The capability the actor used, so a grant can be traced to its exercises. */
  capabilityCode?: string | null;
  /** Free text collected at re-authentication for a destructive action. */
  reason?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditActor {
  userId: string | null;
  label: string | null;
}

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

const USER_AGENT_MAX = 300;

const INSERT_SQL = `
  INSERT INTO audit_log
    (actor_user_id, actor_label, action, entity_table, entity_id,
     capability_code, reason, request_ip, user_agent, details)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9, $10::jsonb)
`;

export function actorFromSession(session: Session | null): AuditActor {
  if (!session) return { userId: null, label: null };
  return {
    userId: session.userId,
    // Stored as text as well as an id, so an old row still names who acted after the account goes.
    label: session.fullName ?? session.username,
  };
}

/**
 * Extracts the caller's address from proxy headers. Behind a reverse proxy or a tunnel the socket
 * address is the proxy, so the forwarded header is the only useful value; the FIRST entry is the
 * client and the rest are hops.
 */
export function requestContext(headers: Headers): RequestContext {
  const forwarded = headers.get('x-forwarded-for');
  const ip =
    headers.get('cf-connecting-ip') ??
    (forwarded ? forwarded.split(',')[0]?.trim() || null : null);
  const userAgent = headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null;
  return { ip, userAgent };
}

function normaliseIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  // An unparseable value would abort the INSERT on the inet cast and lose the whole row.
  const looksLikeIp = /^[0-9a-fA-F:.]+$/.test(ip) && ip.length <= 45;
  return looksLikeIp ? ip : null;
}

/**
 * Appends one audit row. Never throws.
 * Pass `client` to write inside an open transaction, so that the log and the action commit or roll
 * back together for the writes where that matters.
 */
export async function audit(
  entry: AuditEntry,
  actor: AuditActor,
  context: RequestContext = {},
  client?: PoolClient,
): Promise<void> {
  const params = [
    actor.userId,
    actor.label,
    entry.action,
    entry.entityTable ?? null,
    entry.entityId ?? null,
    entry.capabilityCode ?? null,
    entry.reason ?? null,
    normaliseIp(context.ip),
    context.userAgent ?? null,
    JSON.stringify(entry.details ?? {}),
  ];

  try {
    if (client) {
      await client.query(INSERT_SQL, params);
    } else {
      await query(INSERT_SQL, params);
    }
  } catch (err) {
    console.error('[audit] failed to write audit row', { action: entry.action, err });
  }
}

/** Convenience for the common case: an action performed by the current session. */
export async function auditFor(
  session: Session | null,
  headers: Headers,
  entry: AuditEntry,
  client?: PoolClient,
): Promise<void> {
  await audit(entry, actorFromSession(session), requestContext(headers), client);
}

/**
 * The action vocabulary. Kept as one list so the admin log's prefix filters and the writers cannot
 * drift apart; the log filters on `action LIKE 'export.%'` and friends.
 */
export const AUDIT_ACTIONS = {
  authLoginSuccess: 'auth.login.success',
  authLoginFailed: 'auth.login.failed',
  authLogout: 'auth.logout',
  authPasswordChanged: 'auth.password.changed',
  userCreate: 'user.create',
  userUpdate: 'user.update',
  userDeactivate: 'user.deactivate',
  userRolesChange: 'user.roles_change',
  userPasswordReset: 'user.password_reset',
  templatePublish: 'template.publish',
  templateRetire: 'template.retire',
  sessionCreate: 'session.create',
  sessionSign: 'session.sign',
  sessionUnsign: 'session.unsign',
  sessionFinalize: 'session.finalize',
  sessionDelete: 'session.delete',
  recordImport: 'record.import',
  recordAmend: 'record.amend',
  recordDelete: 'record.delete',
  documentUpload: 'document.upload',
  documentDelete: 'document.delete',
  certificateIssue: 'certificate.issue',
  certificateView: 'certificate.view',
  exportPdf: 'export.pdf',
  exportZip: 'export.zip',
  exportBulk: 'export.bulk',
  configActivate: 'config.activate',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
