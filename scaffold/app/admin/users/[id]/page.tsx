import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { getAccount, assetClassOptions, orgUnitOptions, roleOptions, readFlash } from '@/lib/admin';
import { policy } from '@/lib/config';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';

/**
 * /admin/users/[id] - one account.
 *
 * Profile and roster row, the grants it holds with their fleet/base binding, the actions an
 * administrator takes on an account, and the account's own trail from the audit log. Every write
 * is a POST form to /api/admin/users/[id] with a `_action`, so that this page stays a server
 * component and the handler is the one place the rules live. Gate: platform.users.view to read;
 * each action names its own capability on the button and the handler re-checks it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Account' };

interface Trail { occurred_at: string; action: string; actor_label: string | null; reason: string | null; details: Record<string, unknown> }

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.users.view');

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const account = await getAccount(id);
  if (!account) notFound();

  const [fleets, units, roles, trail, flash] = await Promise.all([
    assetClassOptions(),
    orgUnitOptions(),
    roleOptions(),
    query<Trail>(
      `SELECT occurred_at::text, action, actor_label, reason, details
         FROM audit_log
        WHERE (entity_table = 'users' AND entity_id = $1) OR actor_user_id = $1::uuid
        ORDER BY occurred_at DESC LIMIT 40`,
      [id],
    ),
    readFlash(),
  ]);
  const p = policy();
  const manage = can(access, 'platform.users.manage');
  const assign = can(access, 'platform.roles.assign');
  const self = account.id === session.userId;
  const action = `/api/admin/users/${account.id}`;

  return (
    <div className="stack" data-testid="user-detail">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'Users', href: '/admin/users' }, { label: account.username }]} />
      <div className="row">
        <h1 style={{ margin: 0 }}>{account.full_name ?? account.username}</h1>
        {account.is_active ? <Chip tone="good">Active</Chip> : <Chip tone="bad">Inactive</Chip>}
        {account.locked ? <Chip tone="warn">Locked</Chip> : null}
        {account.must_change_password ? <Chip tone="neutral">Must change password</Chip> : null}
      </div>

      {flash ? (
        <div className={`notice${flash.kind === 'bad' ? ' notice-bad' : flash.kind === 'warn' ? ' notice-warn' : ''}`} role="status">
          <p style={{ margin: 0 }}>{flash.message}</p>
          {flash.secret ? (
            <p className="mono secret" style={{ marginBottom: 0 }}>
              <span className="xs muted">{flash.secretLabel ?? 'Temporary password'} - shown once: </span>
              <strong>{flash.secret}</strong>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-tiles">
        <Card title="Account">
          <dl className="props">
            <dt>Username</dt><dd className="mono">{account.username}</dd>
            <dt>E-mail</dt><dd>{account.email ?? <span className="muted">-</span>}</dd>
            <dt>Created</dt><dd>{account.created_at.slice(0, 16).replace('T', ' ')}</dd>
            <dt>Last sign-in</dt><dd>{account.last_login_at ? account.last_login_at.slice(0, 16).replace('T', ' ') : <span className="muted">never</span>}</dd>
          </dl>
        </Card>

        <Card title="Roster row" note={account.person_id ? undefined : 'No roster row is linked. This is a service or administrator account.'}>
          {account.person_id ? (
            <form method="post" action={action} className="stack">
              <input type="hidden" name="_action" value="update_person" />
              <div className="form-grid">
                <div className="field"><label>Employee id</label><input value={account.external_id ?? ''} readOnly className="mono" /></div>
                <div className="field"><label htmlFor="full_name">Full name</label><input id="full_name" name="full_name" defaultValue={account.full_name ?? ''} maxLength={200} disabled={!manage} /></div>
                <div className="field">
                  <label htmlFor="position">Position</label>
                  <select id="position" name="position" defaultValue={account.position ?? ''} disabled={!manage}>
                    <option value="">-</option>
                    {p.positions.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
                <div className="field">
                  <span className="label-text" style={{ display: 'block', marginBottom: 4 }}>Instructor qualifications</span>
                  <div className="row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                    {p.instructor_roles.map((x) => <label key={x} className="check"><input type="checkbox" name="instructor_roles" value={x} defaultChecked={account.instructor_roles.includes(x)} disabled={!manage} /><span className="mono xs">{x}</span></label>)}
                  </div>
                  <span className="xs muted">The highest one is the kit&apos;s instructor role; examiner and instructor logins are granted below.</span>
                </div>
                <div className="field">
                  <label htmlFor="asset_class_id">Fleet</label>
                  <select id="asset_class_id" name="asset_class_id" defaultValue={account.asset_class_id ?? ''} disabled={!manage}>
                    <option value="">-</option>
                    {fleets.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="org_unit_id">Base / unit</label>
                  <select id="org_unit_id" name="org_unit_id" defaultValue={account.org_unit_id ?? ''} disabled={!manage}>
                    <option value="">-</option>
                    {units.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              {manage ? <div><button className="button" type="submit">Save roster row</button></div> : null}
            </form>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>Link a roster row by creating the person under <Link href="/admin/people">Roster</Link> with this account&apos;s username as a note, or recreate the account with an employee id.</p>
          )}
        </Card>
      </div>

      <Card title="Roles and bindings" note="Each row is one grant. A grant bound to a fleet reaches only the people on that fleet; a grant bound to a base reaches that base and the units under it; an unbound grant reaches everyone (migration 0142). A person with two fleets holds two rows." testId="user-grants">
        {account.grants.length === 0 ? <p className="muted small">No roles. This account can sign in and see nothing.</p> : (
          <table className="data">
            <thead><tr><th scope="col">Role</th><th scope="col">Code</th><th scope="col">Fleet</th><th scope="col">Base / unit</th><th scope="col">Expires</th>{assign ? <th scope="col"></th> : null}</tr></thead>
            <tbody>
              {account.grants.map((g) => (
                <tr key={`${g.role_code}-${g.asset_class_code ?? ''}-${g.org_unit_code ?? ''}`}>
                  <td>{g.role_name}</td>
                  <td className="mono xs">{g.role_code}</td>
                  <td>{g.asset_class_code ? <Chip tone="info">{g.asset_class_code}</Chip> : <span className="muted">every fleet</span>}</td>
                  <td>{g.org_unit_code ? <Chip tone="info">{g.org_unit_code}</Chip> : <span className="muted">every base</span>}</td>
                  <td>{g.expires_at ? g.expires_at.slice(0, 10) : <span className="muted">-</span>}</td>
                  {assign ? (
                    <td>
                      <form method="post" action={action}>
                        <input type="hidden" name="_action" value="revoke" />
                        <input type="hidden" name="role_code" value={g.role_code} />
                        <input type="hidden" name="asset_class_code" value={g.asset_class_code ?? ''} />
                        <input type="hidden" name="org_unit_code" value={g.org_unit_code ?? ''} />
                        <button className="button button-quiet xs" type="submit" disabled={self && g.role_code === 'operator_admin'} title={self && g.role_code === 'operator_admin' ? 'You cannot remove your own administrator role' : 'Remove this grant'}>Remove</button>
                      </form>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {assign ? (
          <form method="post" action={action} className="row" style={{ marginTop: 'var(--space-4)', alignItems: 'flex-end' }}>
            <input type="hidden" name="_action" value="grant" />
            <div className="field">
              <label htmlFor="g-role">Add role</label>
              <select id="g-role" name="role_code" required defaultValue="">
                <option value="" disabled>Choose</option>
                {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="g-fleet">Bound to fleet</label>
              <select id="g-fleet" name="asset_class_id" defaultValue=""><option value="">every fleet</option>{fleets.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            </div>
            <div className="field">
              <label htmlFor="g-org">Bound to base / unit</label>
              <select id="g-org" name="org_unit_id" defaultValue=""><option value="">every base</option>{units.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            </div>
            <div className="field"><label htmlFor="g-exp">Expires</label><input id="g-exp" name="expires_on" type="date" /></div>
            <div className="field"><span className="sr-only">Add</span><button className="button" type="submit">Add grant</button></div>
          </form>
        ) : null}
      </Card>

      {manage ? (
        <Card title="Actions" note="Every action is written to the app log with your name.">
          <div className="row">
            <form method="post" action={action}>
              <input type="hidden" name="_action" value="reset_password" />
              <button className="button button-quiet" type="submit">Reset password</button>
            </form>
            {account.locked ? (
              <form method="post" action={action}>
                <input type="hidden" name="_action" value="unlock" />
                <button className="button button-quiet" type="submit">Unlock</button>
              </form>
            ) : null}
            {account.is_active ? (
              <form method="post" action={action}>
                <input type="hidden" name="_action" value="deactivate" />
                <button className="button button-quiet" type="submit" disabled={self} title={self ? 'You cannot deactivate your own account' : 'The account keeps its history and can be reactivated'}>Deactivate</button>
              </form>
            ) : (
              <form method="post" action={action}>
                <input type="hidden" name="_action" value="reactivate" />
                <button className="button button-quiet" type="submit">Reactivate</button>
              </form>
            )}
          </div>
        </Card>
      ) : null}

      <Card title="Trail" note="Audit rows about this account, and rows this account wrote. Newest first, last 40." testId="user-trail">
        {trail.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nothing yet.</p> : (
          <table className="data">
            <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">By</th><th scope="col">Detail</th></tr></thead>
            <tbody>
              {trail.map((t, i) => (
                <tr key={i}>
                  <td className="mono xs">{t.occurred_at.slice(0, 19).replace('T', ' ')}</td>
                  <td className="mono xs">{t.action}</td>
                  <td>{t.actor_label ?? <span className="muted">-</span>}</td>
                  <td className="xs">{t.reason ?? summarise(t.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function summarise(details: Record<string, unknown>): string {
  const keys = Object.keys(details ?? {});
  if (keys.length === 0) return '';
  return keys.slice(0, 4).map((k) => `${k}: ${String(details[k])}`).join(' · ');
}
