import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, can } from '@/lib/access';
import { query } from '@/lib/db';
import { labels, signatureStatements } from '@/lib/config';
import { getSession, STATUS_LABEL, STATUS_TONE } from '@/lib/sessions';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';

/**
 * /sessions/[id] - one session: what it is, who is in it, where it stands.
 *
 * The session's own identity - the program version it is flown against, the pilot and their seat, the
 * device or the route, the signature state and, once finalised, the record it produced. Grading itself
 * is /sessions/[id]/grade, linked from here: this page is what anybody with `training.sessions.view`
 * may read, and the grading surface is what the instructor of record may write.
 *
 * Gate: training.sessions.view.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f-]{36}$/i;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = UUID.test(id) ? await getSession(id) : null;
  return { title: s ? `${s.template_name} · ${s.session_date}` : 'Session' };
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.sessions.view');
  const s = await getSession(id);
  if (!s) notFound();

  const L = labels();
  const statements = signatureStatements(s.template_kind);
  const isMine = s.assessor_id !== null && s.assessor_id === session.personId;
  const canGrade = can(access, 'training.sessions.grade') && isMine;
  const locked = Boolean(s.assessor_signed_at) || s.subjects.some((x) => x.signed_at);
  const records = s.record_count
    ? await query<{ id: string; person_id: string; full_name: string; outcome: string | null }>(
        `SELECT r.id, r.person_id, p.full_name, COALESCE(r.outcome_override, r.outcome) AS outcome
           FROM records r JOIN people p ON p.id = r.person_id
          WHERE r.session_id = $1::uuid AND r.deleted_at IS NULL ORDER BY p.full_name`, [id])
    : [];

  return (
    <div className="stack" data-testid="session-detail">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Sessions', href: '/sessions' }, { label: `${s.template_name} · ${s.session_date}` }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{s.template_name}</h1>
        <span className="small muted">{s.kind_label} · v{s.version_no} · <span className="mono">{s.session_date}</span></span>
        <Chip tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Chip>
        {locked ? <Chip tone="info">Locked by a signature</Chip> : null}
        <span className="spacer" />
        {isMine ? <Link href="/sessions/mine" className="button button-quiet xs" style={{ textDecoration: 'none' }}>My sessions</Link> : null}
        {canGrade && !locked && s.status !== 'finalized' ? <Link href={`/sessions/${id}/grade`} className="button" style={{ textDecoration: 'none' }}>Grade this session</Link> : null}
      </div>

      <div className="profile-grid">
        <Card title="The session" note="Frozen at creation: the analytics read these values, not today's roster.">
          <dl className="report-meta">
            <div><dt>Date</dt><dd className="mono">{s.session_date}</dd></div>
            <div><dt>{s.route ? 'Route' : 'Facility'}</dt><dd>{s.route ?? s.facility ?? '—'}{s.sector_number ? <span className="xs muted"> · sector {s.sector_number}</span> : null}</dd></div>
            <div><dt>{s.check ? 'Check' : 'Fleet'}</dt><dd>{s.check ?? s.fleet ?? '—'}</dd></div>
            <div><dt>Base</dt><dd>{s.base ?? '—'}</dd></div>
            <div><dt>{L.assessor}</dt><dd>{s.assessor_id ? <Link href={`/instructors/${s.assessor_id}`}>{s.assessor_name}</Link> : '—'}</dd></div>
            {/* NO SESSION-LEVEL OUTCOME ROW. The outcome belongs to a PILOT, not to a session:
                saveSessionFields writes it to session_subjects, and on a crewed session one pilot
                can pass while the other does not. This card used to render `sessions.outcome`,
                which nothing writes, so it read "not entered" on every session ever flown -
                including, a moment after signing, ones whose records both said PASS. It is in the
                pilots table below, where it is true. */}
          </dl>
        </Card>

        <Card title={L.subject_plural} note="Every graded element is graded per pilot, in the seat they flew.">
          <table className="data">
            <thead><tr><th scope="col">Name</th><th scope="col">Rank</th><th scope="col">Seat</th><th scope="col">Outcome</th><th scope="col">Signature</th></tr></thead>
            <tbody>{s.subjects.length === 0 ? <tr><td colSpan={5} className="muted small">No pilot on this session.</td></tr> : s.subjects.map((x) => (
              <tr key={x.person_id}>
                <td><Link href={`/subjects/${x.person_id}`}>{x.full_name}</Link></td>
                <td>{x.position ?? '—'}</td>
                <td><strong>{x.seat_role}</strong></td>
                <td>{x.outcome ? <strong>{x.outcome}</strong> : <span className="muted">not entered</span>}</td>
                <td>{x.signed_at ? <Chip tone="good">Signed {x.signed_at.slice(0, 10)}</Chip> : <Chip tone="warn">Not signed</Chip>}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>
            {s.assessor_signed_at ? `Instructor signed ${s.assessor_signed_at.slice(0, 16).replace('T', ' ')}.` : 'Instructor has not signed.'}
            {' '}Everything locks on the <strong>first</strong> signature by either party, so neither can edit after the other has attested.
          </p>
        </Card>
      </div>

      {records.length ? (
        <Card title="The record" note="Frozen at finalisation and independent of the program version from then on.">
          <table className="data">
            <thead><tr><th scope="col">{L.subject}</th><th scope="col">Outcome</th><th scope="col">Where to read it</th></tr></thead>
            <tbody>{records.map((r) => (
              <tr key={r.id}>
                <td>{r.full_name}</td>
                <td>{r.outcome ?? '—'}</td>
                <td><Link href={`/subjects/${r.person_id}`}>On their profile</Link></td>
              </tr>
            ))}</tbody>
          </table>
        </Card>
      ) : null}

      <Card title="Grading">
        {canGrade ? (
          /* THIS PARAGRAPH DESCRIBES THE SESSION'S ACTUAL STATE. It used to say, on every session
             whatever had happened to it, that "signing and the freeze into a record are the next
             slice" - written when they were, and left standing after they were built. It sat under
             a session that had just been signed by three people and frozen into two records, and
             the screen an instructor lands on is the last place to be a year out of date. */
          s.status === 'finalized' ? (
            <p className="small" style={{ margin: 0 }}>
              This session is finalised. Each pilot&apos;s record is frozen on their profile with its own
              signed content and its own PDF, and no longer depends on the program version it was
              flown against. Nothing here can change; an amendment is an unsign, and it is logged.
            </p>
          ) : locked ? (
            <p className="small" style={{ margin: 0 }}>
              A signature has locked this session, so the grades can no longer be edited. What remains
              is the other party&apos;s signature and then finalising, which freezes a record per pilot
              and renders its PDF. <Link href={`/sessions/${id}/grade`}>Open the record</Link> to
              carry on.
            </p>
          ) : (
            <p className="small" style={{ margin: 0 }}>
              This session is yours to grade. <Link href={`/sessions/${id}/grade`}>Open the grading surface</Link> —
              one exercise at a time, observable behaviours, competency grades and the outcome, each written
              as you enter it. Until the first signature the session sits {STATUS_LABEL[s.status].toLowerCase()} and
              can be picked up again at any time.
            </p>
          )
        ) : (
          <p className="small" style={{ margin: 0 }}>
            {isMine ? 'You hold no grading capability, so this is a read-only view.' : `This session is conducted by ${s.assessor_name ?? 'another instructor'}; only they can grade it.`}
          </p>
        )}
        <p className="xs muted" style={{ margin: 'var(--space-2) 0 0' }}>
          On signing, the wording is: “{statements.assessor}”
          {statements.objection.allowed ? <> The trainee may instead {statements.objection.label.toLowerCase()}, which marks the record {statements.objection.marksRecord} and notifies the {statements.objection.notifiesRole.replace('_', ' ')}.</> : null}
        </p>
      </Card>
    </div>
  );
}
