import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { assetClassOptions, orgUnitOptions, roleOptions, readFlash } from '@/lib/admin';
import { policy } from '@/lib/config';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';

/**
 * /admin/users/new - create an account.
 *
 * One form, two objects. The ACCOUNT (username, e-mail) and the ROSTER ROW (employee id, name,
 * position, fleet, base, instructor role) are separate tables in this platform because leaving the
 * roster and losing a login are different events; this screen creates both in one step because
 * that is how an administrator thinks about a new instructor. If an active roster row with the
 * employee id already exists it is linked, not duplicated.
 *
 * Roles are checkboxes; "bind to" decides whether every ticked role is granted for one fleet /
 * base (migration 0142) or unbound. A person with two fleets gets the second grant on the account
 * page afterwards. The password is generated server-side and shown once on the next screen; the
 * account starts with must_change_password = true. Gate: platform.users.create.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'New user' };

export default async function NewUserPage() {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.users.create');

  const [fleets, units, roles, flash] = await Promise.all([assetClassOptions(), orgUnitOptions(), roleOptions(), readFlash()]);
  const p = policy();
  const bases = units;

  return (
    <div className="stack" data-testid="user-new">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'Users', href: '/admin/users' }, { label: 'New user' }]} />
      <h1>New user</h1>

      {flash && flash.kind === 'bad' ? (
        <div className="notice notice-bad" role="alert"><p style={{ margin: 0 }}>{flash.message}</p></div>
      ) : null}

      <form method="post" action="/api/admin/users" className="stack" data-testid="user-new-form">
        <Card title="Account" note="The login. Username is what the person types; it is case-insensitive and cannot be changed later.">
          <div className="form-grid">
            <div className="field"><label htmlFor="username">Username *</label><input id="username" name="username" required minLength={3} maxLength={64} autoComplete="off" placeholder="e.g. j.restrepo" /></div>
            <div className="field"><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" maxLength={200} autoComplete="off" /></div>
          </div>
        </Card>

        <Card title="Roster row" note="Who the account belongs to. Leave the employee id empty for a service or administrator account with no roster row.">
          <div className="form-grid">
            <div className="field"><label htmlFor="external_id">Employee id</label><input id="external_id" name="external_id" maxLength={40} placeholder="e.g. AV-10417" /></div>
            <div className="field"><label htmlFor="full_name">Full name</label><input id="full_name" name="full_name" maxLength={200} /></div>
            <div className="field">
              <label htmlFor="position">Position</label>
              <select id="position" name="position" defaultValue="">
                <option value="">-</option>
                {p.positions.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="instructor_role">Instructor role</label>
              <select id="instructor_role" name="instructor_role" defaultValue="">
                <option value="">None</option>
                {p.instructor_roles.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="asset_class_id">Fleet</label>
              <select id="asset_class_id" name="asset_class_id" defaultValue="">
                <option value="">-</option>
                {fleets.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="org_unit_id">Base / unit</label>
              <select id="org_unit_id" name="org_unit_id" defaultValue="">
                <option value="">-</option>
                {bases.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="joined_on">Joined on</label><input id="joined_on" name="joined_on" type="date" /></div>
          </div>
        </Card>

        <Card title="Roles" note="Tick every role the account holds. A fleet manager or instructor is normally bound to a fleet; an administrator is not.">
          <div className="check-grid">
            {roles.map((r) => (
              <label key={r.value} className="check">
                <input type="checkbox" name="roles" value={r.value} />
                <span>{r.label} <span className="xs muted mono">{r.value}</span></span>
              </label>
            ))}
          </div>
          <div className="form-grid" style={{ marginTop: 'var(--space-4)' }}>
            <div className="field">
              <label htmlFor="bind">Bind the roles to</label>
              <select id="bind" name="bind" defaultValue="fleet">
                <option value="none">Nothing - every fleet and base</option>
                <option value="fleet">The person&apos;s fleet</option>
                <option value="fleet_base">The person&apos;s fleet and base</option>
                <option value="base">The person&apos;s base</option>
              </select>
            </div>
          </div>
        </Card>

        <div className="row">
          <button className="button" type="submit">Create account</button>
          <a className="button button-quiet" href="/admin/users" style={{ textDecoration: 'none' }}>Cancel</a>
          <span className="small muted">A temporary password is generated and shown once on the next screen.</span>
        </div>
      </form>
    </div>
  );
}
