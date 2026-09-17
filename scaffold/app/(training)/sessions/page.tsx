import Link from 'next/link';
import { query } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { labels, policy } from '@/lib/config';
import { listSessions, sessionCounts, STATUS_LABEL, STATUS_TONE, type SessionRow, type SessionStatus } from '@/lib/sessions';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Chip from '@/components/ui/Chip';
import DataTable, { type Column } from '@/components/ui/DataTable';
import FilterBar, { SelectFilter } from '@/components/ui/FilterBar';
import LiveSearch from '@/components/ui/LiveSearch';
import Pager, { pageParams } from '@/components/ui/Pager';

/**
 * /sessions - every session in reach, newest first. docs/04_ETR.md §2.
 *
 * The wide read: a manager's view of what is open, what is awaiting a signature and what has been
 * finalised into a record. The instructor's own queue is /sessions/mine, which is a different
 * question and so a different page rather than a filter people have to discover.
 *
 * Status tabs carry their counts, including zero, because a tab that disappears when empty makes
 * "are there any open sessions?" unanswerable without knowing the tab used to be there.
 *
 * Gate: training.sessions.view, fleet-bound where the grant is.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sessions' };

function one(v: string | string[] | undefined): string { return typeof v === 'string' ? v.trim() : ''; }
const ORDER: SessionStatus[] = ['in_progress', 'submitted', 'signed', 'finalized', 'void'];

export default async function SessionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.sessions.view');
  const L = labels();
  const P = policy();

  const sp = await searchParams;
  const f = { q: one(sp.q), status: one(sp.status), fleet: one(sp.fleet), kind: one(sp.kind), mine: one(sp.mine) };
  const { page, size } = pageParams(sp);
  const [rows, counts, fleets] = await Promise.all([
    listSessions(f, access, page, size),
    sessionCounts(f, access),
    query<{ code: string }>(`SELECT code FROM asset_classes WHERE deleted_at IS NULL AND is_active AND category = 'aircraft' ORDER BY position`),
  ]);
  const total = rows[0]?.total ?? 0;
  const carry: Record<string, string> = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
  const tabHref = (s: string) => `/sessions?${new URLSearchParams({ ...carry, status: s })}`;

  const columns: Column<SessionRow>[] = [
    { key: 'date', head: 'Date', numeric: true, cell: (r) => <Link href={`/sessions/${r.id}`} className="mono">{r.session_date}</Link> },
    {
      key: 'program', head: 'Program',
      cell: (r) => (
        <span className="stack" style={{ gap: 0 }}>
          <Link href={`/sessions/${r.id}`}>{r.template_name}</Link>
          <span className="xs muted">{r.kind_label} · v{r.version_no}{r.check ? ` · ${r.check}` : ''}{r.sector_number ? ` · sector ${r.sector_number}` : ''}</span>
        </span>
      ),
    },
    {
      key: 'subject', head: L.subject_plural,
      cell: (r) => r.subjects.length === 0 ? <span className="muted">none</span> : (
        <span className="stack" style={{ gap: 0 }}>
          {r.subjects.map((s) => (
            <span key={s.person_id} className="small">
              <Link href={`/subjects/${s.person_id}`}>{s.full_name}</Link>
              <span className="xs muted"> · {s.position ?? '—'} · {s.seat_role}</span>
              {s.signed_at ? <span className="xs muted"> · signed</span> : null}
            </span>
          ))}
        </span>
      ),
    },
    { key: 'assessor', head: L.assessor, cell: (r) => r.assessor_id ? <Link href={`/instructors/${r.assessor_id}`}>{r.assessor_name}</Link> : <span className="muted">—</span> },
    { key: 'where', head: 'Where', cell: (r) => <span className="small">{r.route ?? r.facility ?? '—'}{r.fleet ? <span className="xs muted"> · {r.fleet}</span> : null}</span> },
    {
      key: 'status', head: 'Status',
      cell: (r) => (
        <span className="stack" style={{ gap: 2 }}>
          <Chip tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Chip>
          <span className="xs muted">
            {r.assessor_signed_at ? 'instructor signed' : r.status === 'in_progress' ? (r.session_date > new Date().toISOString().slice(0, 10) ? 'planned' : 'to grade') : ''}
            {r.record_count ? ` · ${r.record_count} record${r.record_count === 1 ? '' : 's'}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'outcome', head: 'Outcome', cell: (r) => r.outcome ? <Chip tone={/FAIL|NOT|INCOMPLETE/.test(r.outcome) ? 'bad' : 'good'}>{r.outcome}</Chip> : <span className="muted">—</span> },
  ];

  return (
    <div className="stack" data-testid="session-list">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Sessions' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Sessions</h1>
        <span className="xs muted">what is open, what is signed, what became a record</span>
        <span className="spacer" />
        {can(access, 'training.sessions.grade') ? <Link href="/sessions/mine" className="button button-quiet" style={{ textDecoration: 'none' }}>My sessions</Link> : null}
        {can(access, 'training.sessions.create') ? <Link href="/sessions/new" className="button" style={{ textDecoration: 'none' }}>New session</Link> : null}
      </div>

      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <Link href={`/sessions?${new URLSearchParams({ ...carry, status: '' })}`} className={`button xs ${f.status ? 'button-quiet' : ''}`} style={{ textDecoration: 'none' }}>
          All {Object.values(counts).reduce((s, n) => s + n, 0)}
        </Link>
        {ORDER.map((s) => (
          <Link key={s} href={tabHref(s)} className={`button xs ${f.status === s ? '' : 'button-quiet'}`} style={{ textDecoration: 'none' }}>
            {STATUS_LABEL[s]} {counts[s] ?? 0}
          </Link>
        ))}
      </div>

      <FilterBar action="/sessions" resetHref="/sessions" carry={{ status: f.status || undefined, mine: f.mine || undefined }}>
        <LiveSearch name="q" label="Program, pilot or instructor" value={f.q} placeholder="Type to search" />
        <SelectFilter name="kind" label="Kind" value={f.kind} options={P.template_kinds.map((k) => ({ value: k.kind, label: k.label }))} />
        <SelectFilter name="fleet" label="Fleet" value={f.fleet} options={fleets.map((x) => ({ value: x.code, label: x.code }))} />
      </FilterBar>

      <DataTable
        testId="session-table"
        caption="Sessions, most recent first"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyTitle="No session matched"
        emptyReason="Nothing here matched these filters, or none is in your scope."
        countSuffix={total > rows.length ? `of ${total}` : undefined}
      />
      <Pager path="/sessions" params={carry} page={page} size={size} total={total} noun="sessions" />
    </div>
  );
}
