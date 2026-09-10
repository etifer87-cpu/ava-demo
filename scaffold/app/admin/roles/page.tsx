import { Fragment } from 'react';
import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { readFlash } from '@/lib/admin';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';

/**
 * /admin/roles - the role by capability matrix, and the editor for one role.
 *
 * The permission model is rows in two tables (roles, role_capabilities) and nothing else; this
 * screen shows those rows and lets an administrator change them. Reading is the matrix: every
 * role across, every capability down, grouped by module, the cell being the scope held. Editing
 * is per role: a scope selector on every capability, saved as one form, applied as one
 * transaction, one audit row per changed cell.
 *
 * Two things are deliberately not editable. `operator_admin` holds everything, always - it is
 * how the operator's administrator gets back in after any mistake here. And a capability flagged
 * `is_overridable = false` (a hard gate) is shown locked: the kit's rule is that such a capability
 * is conferred only by the published matrix, never by exception, and the published matrix is the
 * migration, not this screen. Gate: platform.roles.assign.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Roles and permissions' };

const SCOPES = ['own', 'assigned', 'team', 'org', 'all'] as const;
const LOCKED_ROLES = new Set(['operator_admin']);

interface Role { code: string; name: string; module: string; description: string; position: number; holders: number }
interface Cap { code: string; module: string; resource: string; action: string; is_scoped: boolean; is_overridable: boolean; description: string }
interface Grant { role_code: string; capability_code: string; scope: string }

function one(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function RolesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.roles.assign');

  const sp = await searchParams;
  const selected = one(sp.role);

  const [roles, caps, grants, flash] = await Promise.all([
    query<Role>(`
      SELECT r.code, r.name, r.module, r.description, r.position,
             (SELECT count(DISTINCT ur.user_id)::int FROM user_roles ur JOIN users u ON u.id = ur.user_id AND u.deleted_at IS NULL
               WHERE ur.role_code = r.code AND (ur.expires_at IS NULL OR ur.expires_at > now())) AS holders
        FROM roles r ORDER BY r.position, r.code`),
    query<Cap>(`SELECT code, module, resource, action, is_scoped, is_overridable, description FROM capabilities ORDER BY module, resource, action`),
    query<Grant>(`SELECT role_code, capability_code, scope FROM role_capabilities`),
    readFlash(),
  ]);

  const held = new Map<string, string[]>();
  for (const g of grants) {
    const k = `${g.role_code}|${g.capability_code}`;
    held.set(k, [...(held.get(k) ?? []), g.scope]);
  }
  const scopeOf = (role: string, cap: string) => held.get(`${role}|${cap}`) ?? [];
  const widest = (scopes: string[]) => SCOPES.slice().reverse().find((s) => scopes.includes(s)) ?? '';
  const modules = [...new Set(caps.map((c) => c.module))];
  const role = roles.find((r) => r.code === selected) ?? null;
  const locked = role ? LOCKED_ROLES.has(role.code) : false;

  return (
    <div className="stack" data-testid="role-matrix">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin' }, { label: 'Roles and permissions' }]} />
      <div className="row">
        <h1 style={{ margin: 0 }}>Roles and permissions</h1>
        <span className="small muted">{roles.length} roles · {caps.length} capabilities · {grants.length} grants</span>
      </div>

      {flash ? <div className={`notice${flash.kind === 'bad' ? ' notice-bad' : flash.kind === 'warn' ? ' notice-warn' : ''}`} role="status"><p style={{ margin: 0 }}>{flash.message}</p></div> : null}

      <Card title="Roles" note="Choose a role to edit its permissions. Holder counts are live grants; the label is what people see, the code is what routes check.">
        <div className="role-grid">
          {roles.map((r) => (
            <Link key={r.code} href={`/admin/roles?role=${r.code}`} className={`role-card${r.code === selected ? ' role-card-selected' : ''}${r.holders === 0 ? ' role-card-empty' : ''}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="row" style={{ alignItems: 'baseline' }}>
                <span className="role-count">{r.holders}</span>
                <span className="xs muted">{r.module}</span>
                {LOCKED_ROLES.has(r.code) ? <Chip tone="neutral">locked</Chip> : null}
              </div>
              <div className="role-name">{r.name}</div>
              <p className="xs muted role-desc">{r.description}</p>
            </Link>
          ))}
        </div>
        <details style={{ marginTop: 'var(--space-4)' }}>
          <summary className="small">New role</summary>
          <form method="post" action="/api/admin/roles" className="stack" style={{ marginTop: 'var(--space-3)' }}>
            <input type="hidden" name="_action" value="create_role" />
            <div className="form-grid">
              <div className="field"><label htmlFor="new-code">Code *</label><input id="new-code" name="code" required pattern="[a-z][a-z0-9_]{2,39}" placeholder="e.g. fleet_manager_a330" className="mono" /></div>
              <div className="field"><label htmlFor="new-name">Label *</label><input id="new-name" name="name" required maxLength={80} /></div>
              <div className="field">
                <label htmlFor="new-module">Module</label>
                <select id="new-module" name="module" defaultValue="training">
                  {['platform', 'training', 'qms', 'dms', 'planning', 'integration'].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="field"><label htmlFor="new-copy">Start from</label>
                <select id="new-copy" name="copy_from" defaultValue="">
                  <option value="">No permissions</option>
                  {roles.filter((r) => !LOCKED_ROLES.has(r.code)).map((r) => <option key={r.code} value={r.code}>Copy {r.name}</option>)}
                </select>
              </div>
            </div>
            <div className="field"><label htmlFor="new-desc">Description</label><input id="new-desc" name="description" maxLength={300} /></div>
            <div><button className="button" type="submit">Create role</button></div>
          </form>
        </details>
      </Card>

      {role ? (
        <Card title={`Edit: ${role.name}`} note={locked ? 'This role holds every capability at every scope and cannot be edited: it is how the administrator gets back in after any mistake on this screen.' : 'One row per capability. "none" removes the grant. A row marked "fixed" is a hard gate: conferred only by the published matrix (a migration), never here. Changes apply on the next request for every holder.'} testId="role-editor">
          <form method="post" action="/api/admin/roles" className="stack">
            <input type="hidden" name="_action" value="update_role" />
            <input type="hidden" name="code" value={role.code} />
            <div className="form-grid">
              <div className="field"><label>Code</label><input value={role.code} readOnly className="mono" /></div>
              <div className="field"><label htmlFor="r-name">Label</label><input id="r-name" name="name" defaultValue={role.name} maxLength={80} disabled={locked} /></div>
              <div className="field"><label htmlFor="r-desc">Description</label><input id="r-desc" name="description" defaultValue={role.description} maxLength={300} disabled={locked} /></div>
            </div>
            {!locked ? <div><button className="button button-quiet" type="submit">Save label</button></div> : null}
          </form>

          {!locked ? (
            <form method="post" action="/api/admin/roles" className="stack" style={{ marginTop: 'var(--space-4)' }}>
              <input type="hidden" name="_action" value="set_grants" />
              <input type="hidden" name="code" value={role.code} />
              {modules.map((m) => (
                <div key={m} className="table-wrap">
                  <table className="data matrix">
                    <caption>{m}</caption>
                    <thead><tr><th scope="col">Capability</th><th scope="col">What it allows</th><th scope="col">Scope</th></tr></thead>
                    <tbody>
                      {caps.filter((c) => c.module === m).map((c) => {
                        const cur = scopeOf(role.code, c.code);
                        const hard = !c.is_overridable;
                        return (
                          <tr key={c.code}>
                            <td className="mono xs">{c.code}</td>
                            <td className="xs">{c.description}</td>
                            <td>
                              {hard ? (
                                <span className="xs">
                                  {cur.length ? cur.join(' + ') : <span className="muted">none</span>}
                                  <span className="muted" title="Conferred by the published matrix - a migration - and never by exception"> · fixed</span>
                                </span>
                              ) : (
                                <select name={`scope:${c.code}`} defaultValue={widest(cur)} aria-label={`Scope for ${c.code}`}>
                                  <option value="">none</option>
                                  {(c.is_scoped ? SCOPES : ['all'] as readonly string[]).map((s) => <option key={s} value={s}>{s}</option>)}
                                </select>
                              )}
                              {cur.length > 1 ? <span className="xs muted" title="Held at more than one scope; saving keeps the one selected"> ({cur.join(' + ')})</span> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
              <div className="row">
                <button className="button" type="submit">Save permissions</button>
                <span className="small muted">Every changed cell is written to the app log.</span>
              </div>
            </form>
          ) : null}
        </Card>
      ) : null}

      <Card title="Matrix" note="Every role across, every capability down. A cell is the widest scope the role holds; blank means no grant. Read from the database, never from a document." testId="matrix">
        <div className="table-wrap">
          <table className="data matrix matrix-wide">
            <thead>
              <tr>
                <th scope="col">Capability</th>
                {roles.map((r) => <th key={r.code} scope="col" className="matrix-role"><Link href={`/admin/roles?role=${r.code}`} title={r.name}>{r.code}</Link></th>)}
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => (
                <Fragment key={m}>
                  <tr className="matrix-module"><th scope="rowgroup" colSpan={roles.length + 1}>{m}</th></tr>
                  {caps.filter((c) => c.module === m).map((c) => (
                    <tr key={c.code}>
                      <th scope="row" className="mono xs">{c.code}</th>
                      {roles.map((r) => {
                        const s = widest(scopeOf(r.code, c.code));
                        return <td key={r.code} className={`matrix-cell${s ? ` scope-${s}` : ''}`}>{s || ''}</td>;
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
