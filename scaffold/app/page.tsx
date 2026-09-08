import Link from 'next/link';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { getSession } from '@/lib/session';
import { resolveAccess, can, visiblePersonIds, ALL_PEOPLE, type ResolvedAccess } from '@/lib/access';
import Card from '@/components/ui/Card';
import EmptyState from '@/components/ui/EmptyState';

/**
 * The signed-in landing page.
 *
 * It shows counts of what the caller can actually see, and one tile per module the caller can
 * actually enter. A tile for a module without the capability is NOT RENDERED. The routes behind
 * the tiles re-check; this page is presentation.
 *
 * Every count is scoped through lib/access.ts. Counting rows and then hiding some in the render is
 * how a total that contradicts the list underneath it gets shipped.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CountRow { n: string }

async function scopedPeopleCount(access: ResolvedAccess): Promise<number | null> {
  if (!can(access, 'people.view')) return null;
  const visible = await visiblePersonIds(access, 'people.view');
  if (visible === ALL_PEOPLE) {
    const rows = await query<CountRow>(
      'SELECT count(*)::text AS n FROM people WHERE deleted_at IS NULL AND is_active',
    );
    return Number(rows[0]?.n ?? 0);
  }
  if (visible.size === 0) return 0;
  const rows = await query<CountRow>(
    `SELECT count(*)::text AS n FROM people
      WHERE deleted_at IS NULL AND is_active AND id = ANY($1::uuid[])`,
    [[...visible]],
  );
  return Number(rows[0]?.n ?? 0);
}

async function scopedRecordCount(access: ResolvedAccess): Promise<number | null> {
  if (!can(access, 'training.records.view')) return null;
  const visible = await visiblePersonIds(access, 'training.records.view');
  if (visible === ALL_PEOPLE) {
    // Every source. `source` groups records; it never filters them. A read surface that queries
    // one source reports zero for the others and nobody notices for a quarter.
    const rows = await query<CountRow>(
      'SELECT count(*)::text AS n FROM records WHERE deleted_at IS NULL',
    );
    return Number(rows[0]?.n ?? 0);
  }
  if (visible.size === 0) return 0;
  const rows = await query<CountRow>(
    `SELECT count(*)::text AS n FROM records
      WHERE deleted_at IS NULL AND person_id = ANY($1::uuid[])`,
    [[...visible]],
  );
  return Number(rows[0]?.n ?? 0);
}

async function frameworkSummary(): Promise<{ name: string; competencies: number; obs: number } | null> {
  const rows = await query<{ name: string; competencies: string; obs: string }>(
    `SELECT f.name,
            count(DISTINCT c.id)::text  AS competencies,
            count(DISTINCT ob.id)::text AS obs
       FROM competency_frameworks f
       LEFT JOIN competencies c            ON c.framework_id = f.id AND c.is_active
       LEFT JOIN observable_behaviours ob  ON ob.framework_id = f.id AND ob.is_active
      WHERE f.is_active
      GROUP BY f.name`,
  );
  const r = rows[0];
  return r ? { name: r.name, competencies: Number(r.competencies), obs: Number(r.obs) } : null;
}

const TILES: ReadonlyArray<{ href: string; title: string; body: string; capability: string }> = [
  { href: '/subjects', title: 'Subjects', body: 'The roster, with concern state and competency profiles.', capability: 'people.view' },
  { href: '/sessions', title: 'Sessions', body: 'Training events open for grading, and the ones awaiting signature.', capability: 'training.sessions.view' },
  { href: '/records', title: 'Records', body: 'Signed records from every source: in-app, imported and ingested.', capability: 'training.records.view' },
  { href: '/templates', title: 'Templates', body: 'Form definitions and their published versions.', capability: 'training.templates.view' },
  { href: '/analytics', title: 'Analytics', body: 'Programme indicators, competency distributions and trends.', capability: 'training.analytics.programme.view' },
  { href: '/qms/qualifications', title: 'Qualifications', body: 'Validity, expiry warnings and evidence.', capability: 'qms.qualifications.view' },
  { href: '/dms/documents', title: 'Documents', body: 'Filed documents, versions and retention.', capability: 'dms.documents.view' },
  { href: '/admin/people', title: 'Administration', body: 'Accounts, roles, configuration and the audit log.', capability: 'platform.settings.manage' },
];

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card">
      <div className="xs muted" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 'var(--text-2xl)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{value}</div>
      {note ? <div className="xs muted">{note}</div> : null}
    </div>
  );
}

export default async function LandingPage() {
  const session = await getSession();
  if (!session) redirect('/login?next=%2F');
  if (session.mustChangePassword) redirect('/change-password');

  const access = await resolveAccess(session);
  const [people, records, framework] = await Promise.all([
    scopedPeopleCount(access),
    scopedRecordCount(access),
    frameworkSummary(),
  ]);

  const tiles = TILES.filter((t) => can(access, t.capability));

  return (
    <div className="stack" data-testid="dashboard">
      <h1>Overview</h1>
      <p className="muted small">
        Signed in as {session.fullName ?? session.username}. Everything below is scoped to what this
        account may see.
      </p>

      <div className="grid grid-kpi">
        {people !== null ? <Stat label="Subjects" value={String(people)} note="active on the roster, in scope" /> : null}
        {records !== null ? <Stat label="Records" value={String(records)} note="all sources, in scope" /> : null}
        {framework ? (
          <Stat
            label="Framework"
            value={`${framework.competencies}`}
            note={`competencies, ${framework.obs} observable behaviours - ${framework.name}`}
          />
        ) : (
          <Stat label="Framework" value="none" note="run npm run seed:framework" />
        )}
      </div>

      {tiles.length === 0 ? (
        <EmptyState
          title="No module is available to this account"
          reason="The account is authenticated but holds no module capability. An administrator grants a role on the account's roles page."
        />
      ) : (
        <div className="grid grid-tiles">
          {tiles.map((t) => (
            <Card key={t.href} title={<Link href={t.href}>{t.title}</Link>}>
              <p className="small muted" style={{ margin: 0 }}>{t.body}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
