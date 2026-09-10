import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { roleSummaries } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import Popup from '@/components/ui/Popup';

/**
 * /admin - the administration hub.
 *
 * Four things on one screen, in the order an administrator asks about them: how many accounts and
 * people exist; who holds which role (a grid, one card per role, the holder list one click away
 * without leaving the page); and the doors into the three working screens - Users, App Log, Tech
 * Log - plus the kit's remaining admin routes, each shown only when the caller holds its gate.
 *
 * Gate: platform.users.view. Every card re-checks its own capability; a door the caller cannot
 * open is not drawn.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

interface Counts {
  accounts_active: string;
  accounts_inactive: string;
  people_active: string;
  tickets_open: string;
  audit_24h: string;
}

const DOORS = [
  { href: '/admin/users',   title: 'Users',    body: 'Accounts, roles and fleet bindings. Create an account, reset a password, deactivate.', capability: 'platform.users.view',   testId: 'door-users' },
  { href: '/admin/audit',   title: 'App Log',  body: 'Who did what, when: sign-ins, account changes, publishes, signatures, exports.',        capability: 'platform.audit.view',   testId: 'door-audit' },
  { href: '/admin/tickets', title: 'Tech Log', body: 'Problems and requests reported from inside the application, with their history.',   capability: 'platform.tickets.triage', testId: 'door-tickets' },
  { href: '/admin/people',  title: 'Roster',   body: 'People the platform trains and assesses. An account and a roster row are different things.', capability: 'people.manage', testId: 'door-people' },
  { href: '/admin/org',     title: 'Organisation', body: 'Bases, departments and fleets.',                                                 capability: 'people.manage',         testId: 'door-org' },
  { href: '/admin/roles',   title: 'Role matrix', body: 'Which role holds which capability, at which scope - read from the database.',    capability: 'platform.roles.assign', testId: 'door-roles' },
  { href: '/admin/config',  title: 'Configuration', body: 'Active analytics and policy versions.',                                        capability: 'platform.config.manage', testId: 'door-config' },
] as const;

export default async function AdminHub() {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.users.view');

  const [counts, roles] = await Promise.all([
    query<Counts>(`
      SELECT (SELECT count(*) FROM users WHERE deleted_at IS NULL AND is_active)::text      AS accounts_active,
             (SELECT count(*) FROM users WHERE deleted_at IS NULL AND NOT is_active)::text  AS accounts_inactive,
             (SELECT count(*) FROM people WHERE deleted_at IS NULL AND is_active)::text     AS people_active,
             (SELECT count(*) FROM tech_tickets WHERE status IN ('open','in_progress'))::text AS tickets_open,
             (SELECT count(*) FROM audit_log WHERE occurred_at > now() - interval '24 hours')::text AS audit_24h
    `).then((r) => r[0] ?? { accounts_active: '0', accounts_inactive: '0', people_active: '0', tickets_open: '0', audit_24h: '0' }),
    roleSummaries(),
  ]);

  const doors = DOORS.filter((d) => can(access, d.capability));

  return (
    <div className="stack" data-testid="admin-hub">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin' }]} />
      <h1>Administration</h1>

      <div className="grid grid-kpi" data-testid="admin-stats">
        <Stat label="Active accounts" value={counts.accounts_active} note={`${counts.accounts_inactive} inactive`} href="/admin/users" />
        <Stat label="People on the roster" value={counts.people_active} note="active roster rows" href="/subjects" />
        <Stat label="Open tickets" value={counts.tickets_open} note="open or in progress" href="/admin/tickets" />
        <Stat label="Audit events, 24 h" value={counts.audit_24h} note="rows written to the app log" href="/admin/audit" />
      </div>

      <Card title="Roles" note="One card per role with the number of active holders. Open a role to see who holds it and how each grant is bound." testId="admin-roles">
        <div className="role-grid">
          {roles.map((r) => (
            <div key={r.code} className={`role-card${r.user_count === 0 ? ' role-card-empty' : ''}`}>
              <div className="row" style={{ alignItems: 'baseline' }}>
                <span className="role-count">{r.user_count}</span>
                <span className="xs muted">{r.module}</span>
              </div>
              <div className="role-name">{r.name}</div>
              <div className="xs mono muted">{r.code}</div>
              <p className="xs muted role-desc">{r.description}</p>
              <Popup label={r.user_count === 0 ? 'No holders' : `View ${r.user_count}`} title={`${r.name} - ${r.user_count} holder${r.user_count === 1 ? '' : 's'}`} buttonClassName="button button-quiet xs" testId={`role-popup-${r.code}`}>
                {r.users.length === 0 ? (
                  <p className="muted small">Nobody holds this role.</p>
                ) : (
                  <table className="data">
                    <thead>
                      <tr><th scope="col">Name</th><th scope="col">Username</th><th scope="col">Bound to</th><th scope="col">Status</th></tr>
                    </thead>
                    <tbody>
                      {r.users.map((u) => (
                        <tr key={`${u.id}-${u.binding ?? 'all'}`}>
                          <td><Link href={`/admin/users/${u.id}`}>{u.full_name ?? <span className="muted">no roster row</span>}</Link></td>
                          <td className="mono">{u.username}</td>
                          <td>{u.binding ? <Chip tone="info">{u.binding}</Chip> : <span className="muted">every fleet / base</span>}</td>
                          <td>{u.is_active ? <Chip tone="good">Active</Chip> : <Chip tone="bad">Inactive</Chip>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Popup>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-tiles" data-testid="admin-doors">
        {doors.map((d) => (
          <Card key={d.href} title={<Link href={d.href}>{d.title}</Link>} testId={d.testId}>
            <p className="small muted" style={{ margin: 0 }}>{d.body}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, note, href }: { label: string; value: string; note: string; href: string }) {
  return (
    <Link href={href} className="stat" style={{ textDecoration: 'none' }}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <div className="xs muted">{note}</div>
    </Link>
  );
}
