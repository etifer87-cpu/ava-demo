import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { assetClassOptions, orgUnitOptions, roleOptions, readFlash, getPerson, suggestUsername } from '@/lib/admin';
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
 *
 * `?person=<id>` opens the form for a pilot already on the roster: identity fields come from the
 * roster row and are not editable here, the username is suggested from the name, and the roles
 * are pre-ticked from the qualifications (examiner for TRE/SFE, instructor for TRI/SFI/LTC/CRMI,
 * ground instructor for GI, trainee for everyone) - the administrator changes what needs changing.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'New user' };

export default async function NewUserPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.users.create');

  const sp = await searchParams;
  const personId = typeof sp.person === 'string' && /^[0-9a-f-]{36}$/i.test(sp.person) ? sp.person : null;
  const [fleets, units, roles, flash, person] = await Promise.all([assetClassOptions(), orgUnitOptions(), roleOptions(), readFlash(), personId ? getPerson(personId) : Promise.resolve(null)]);
  const p = policy();
  const bases = units;
  const suggested = person ? await suggestUsername(person.full_name) : '';
  const quals = person?.instructor_roles ?? [];
  const preRoles = new Set<string>();
  if (person) {
    preRoles.add('trainee');
    if (quals.some((r) => r === 'TRE' || r === 'SFE')) preRoles.add('examiner');
    if (quals.some((r) => ['TRI', 'SFI', 'LTC', 'CRMI'].includes(r))) preRoles.add('instructor');
    if (quals.includes('GI')) preRoles.add('ground_instructor');
  }

  return (
    <div className="stack" data-testid="user-new">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'Users', href: '/admin/users' }, { label: 'New user' }]} />
      <h1>New user</h1>
      {person ? <p className="small muted" style={{ margin: 0 }}>Account for <strong>{person.full_name}</strong> (seniority {person.external_id}, {person.position ?? 'candidate'}{person.fleet ? ` ${person.fleet}` : ''}{person.base ? `, ${person.base}` : ''}){person.has_user ? ' - this person already has an account.' : '.'}</p> : null}

      {flash && flash.kind === 'bad' ? (
        <div className="notice notice-bad" role="alert"><p style={{ margin: 0 }}>{flash.message}</p></div>
      ) : null}

      <form method="post" action="/api/admin/users" className="stack" data-testid="user-new-form">
        <Card title="Account" note="The login. Username is what the person types; it is case-insensitive and cannot be changed later.">
          <div className="form-grid">
            <div className="field"><label htmlFor="username">Username *</label><input id="username" name="username" required minLength={3} maxLength={64} autoComplete="off" placeholder="e.g. j.restrepo" defaultValue={suggested} /></div>
            <div className="field"><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" maxLength={200} autoComplete="off" /></div>
          </div>
        </Card>

        <Card title="Roster row" note={person ? 'From the roster. Rank, fleet and base are changed on the account page or on the roster, not here.' : 'Who the account belongs to. Leave the employee id empty for a service or administrator account with no roster row.'}>
          {person ? (
            <div className="form-grid">
              <input type="hidden" name="external_id" value={person.external_id} />
              <input type="hidden" name="full_name" value={person.full_name} />
              <div className="field"><label>Seniority / id</label><input value={person.external_id} readOnly className="mono" /></div>
              <div className="field"><label>Full name</label><input value={person.full_name} readOnly /></div>
              <div className="field"><label>Rank</label><input value={person.position ?? '-'} readOnly /></div>
              <div className="field"><label>Fleet</label><input value={person.fleet ?? '-'} readOnly /></div>
              <div className="field"><label>Base</label><input value={person.base ?? '-'} readOnly /></div>
              <div className="field"><label>Qualifications</label><input value={quals.join(' ') || 'none'} readOnly className="mono" /></div>
            </div>
          ) : (
          <div className="form-grid">
            <div className="field"><label htmlFor="external_id">Employee id</label><input id="external_id" name="external_id" maxLength={40} placeholder="e.g. 501" /></div>
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
          )}
        </Card>

        <Card title="Roles" note="Tick every role the account holds. A fleet manager or instructor is normally bound to a fleet; an administrator is not.">
          <div className="check-grid">
            {roles.map((r) => (
              <label key={r.value} className="check">
                <input type="checkbox" name="roles" value={r.value} defaultChecked={preRoles.has(r.value)} />
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
          {person?.has_user ? <span className="small" style={{ color: 'var(--state-bad)' }}>This person already has an account; creating another will be refused.</span> : null}
          <span className="small muted">A temporary password is generated and shown once on the next screen.</span>
        </div>
      </form>
    </div>
  );
}
