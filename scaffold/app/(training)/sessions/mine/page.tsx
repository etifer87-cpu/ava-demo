import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { labels } from '@/lib/config';
import { listSessions, STATUS_LABEL, STATUS_TONE, type SessionRow } from '@/lib/sessions';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';

/**
 * /sessions/mine - the sessions this instructor is assigned to grade, and the way to open a new one.
 *
 * Separate from /sessions because they answer different questions: /sessions is every session flown,
 * which is a manager's read; this is the queue one person is accountable for. Grouped the way an
 * instructor's day is - to grade today, planned ahead, waiting on a signature, finalised - rather
 * than as one table sorted by date, because "what do I have to do" is the only question this page
 * exists to answer.
 *
 * Gate: training.sessions.grade. An account with no roster row sees the reason, not an empty list.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'My sessions' };

const today = () => new Date().toISOString().slice(0, 10);

function Group({ title, note, rows, empty, subjectLabel }: { readonly title: string; readonly note: string; readonly rows: readonly SessionRow[]; readonly empty: string; readonly subjectLabel: string }) {
  return (
    <Card title={<>{title} <span className="xs muted">{rows.length}</span></>} note={note}>
      {rows.length === 0 ? <p className="muted small" style={{ margin: 0 }}>{empty}</p> : (
        <table className="data">
          <thead><tr><th scope="col" className="num">Date</th><th scope="col">Program</th><th scope="col">{subjectLabel}</th><th scope="col">Where</th><th scope="col">Status</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td className="num mono"><Link href={`/sessions/${r.id}`}>{r.session_date}</Link></td>
              <td>
                <Link href={`/sessions/${r.id}`}>{r.template_name}</Link>
                <span className="xs muted"> · v{r.version_no}{r.check ? ` · ${r.check}` : ''}{r.sector_number ? ` · sector ${r.sector_number}` : ''}</span>
              </td>
              <td className="small">{r.subjects.map((s) => `${s.full_name} (${s.seat_role})`).join(', ') || '—'}</td>
              <td className="small">{r.route ?? r.facility ?? '—'}</td>
              <td>
                <Chip tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Chip>
                {r.subjects.some((s) => s.signed_at) ? <span className="xs muted"> trainee signed</span> : null}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

export default async function MySessionsPage() {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.sessions.grade');
  const L = labels();
  const canCreate = can(access, 'training.sessions.create');

  if (!session.personId) {
    return (
      <div className="stack" data-testid="my-session-list">
        <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'My sessions' }]} />
        <h1 style={{ margin: 0 }}>My sessions</h1>
        <div className="notice notice-warn">
          <p style={{ margin: 0 }}>
            This account is not linked to a roster row, so no session can name it as the instructor. An
            administrator can link it on the account page; until then you can read sessions but not grade one.
          </p>
        </div>
      </div>
    );
  }

  const rows = await listSessions({ q: '', status: '', fleet: '', kind: '', mine: '1' }, access, 1, 200);
  const d = today();
  const open = rows.filter((r) => r.status === 'in_progress' && r.session_date <= d);
  const planned = rows.filter((r) => r.status === 'in_progress' && r.session_date > d);
  const waiting = rows.filter((r) => r.status === 'submitted' || r.status === 'signed');
  const done = rows.filter((r) => r.status === 'finalized').slice(0, 20);

  return (
    <div className="stack" data-testid="my-session-list">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'My sessions' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>My sessions</h1>
        <span className="xs muted">{session.fullName ?? session.username}</span>
        <span className="spacer" />
        <Link href="/sessions" className="button button-quiet" style={{ textDecoration: 'none' }}>All sessions</Link>
        {canCreate ? <Link href="/sessions/new" className="button" style={{ textDecoration: 'none' }}>New session</Link> : null}
      </div>

      <Group title="To grade" note="Today or earlier, still open. Grading is the only thing that moves one of these on." rows={open} empty="Nothing waiting to be graded." subjectLabel={L.subject_plural} />
      <Group title="Planned" note="Dated ahead. A planned session is a real session with no grades yet, which is what the training-status board reads as “next”." rows={planned} empty="Nothing planned." subjectLabel={L.subject_plural} />
      <Group title="Awaiting a signature" note="Signed by one party. Everything locks on the FIRST signature, so these cannot be edited - an amendment is an unsign." rows={waiting} empty="Nothing awaiting a signature." subjectLabel={L.subject_plural} />
      <Group title="Finalised" note="Frozen into a record. The twenty most recent." rows={done} empty="No finalised session yet." subjectLabel={L.subject_plural} />
    </div>
  );
}
