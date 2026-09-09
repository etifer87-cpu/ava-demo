import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability } from '@/lib/access';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, ticketRef } from '@/lib/tickets';
import { query } from '@/lib/db';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import { StatusChip } from '@/components/ui/TicketChips';

/**
 * /support/report - report a problem with the application (the Tech Log intake).
 *
 * Open to every signed-in role (platform.tickets.create, granted to all by migration 0143). The
 * form asks for the minimum that makes a report actionable - what, where, how bad - and the page
 * the reporter came from is carried in `from` so the administrator sees the route. Below the form,
 * the reporter's own tickets and their current status, so "did anyone see this?" has an answer.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Report a problem' };

interface Mine { id: string; number: string; subject: string; status: string; created_at: string; last_event_at: string }

export default async function ReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'platform.tickets.create');

  const sp = await searchParams;
  const from = typeof sp.from === 'string' && sp.from.startsWith('/') ? sp.from.slice(0, 200) : '';
  const sent = typeof sp.sent === 'string' && /^\d+$/.test(sp.sent) ? sp.sent : '';
  const error = typeof sp.error === 'string' ? sp.error.slice(0, 200) : '';
  const mine = await query<Mine>(
    `SELECT id, number::text, subject, status, created_at::text, last_event_at::text FROM tech_tickets WHERE reporter_user_id = $1::uuid ORDER BY created_at DESC LIMIT 20`,
    [session.userId],
  );

  return (
    <div className="stack" data-testid="support-report" style={{ maxWidth: '46rem' }}>
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Report a problem' }]} />
      <h1>Report a problem</h1>

      {error ? <div className="notice notice-bad" role="alert"><p style={{ margin: 0 }}>{error}</p></div> : null}
      {sent ? <div className="notice" role="status"><p style={{ margin: 0 }}>Thank you - ticket <span className="mono">{ticketRef(sent)}</span> is filed and the administrators can see it.</p></div> : null}

      <form method="post" action="/api/tickets" className="stack" data-testid="report-form">
        <input type="hidden" name="route" value={from} />
        <Card title="What happened" note="Say what you expected, what you saw instead, and which pilot, session or document it concerns. Never include a password.">
          <div className="form-grid">
            <div className="field"><label htmlFor="subject">Subject *</label><input id="subject" name="subject" required minLength={3} maxLength={200} /></div>
            <div className="field">
              <label htmlFor="category">Category</label>
              <select id="category" name="category" defaultValue="bug">
                {TICKET_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="priority">How urgent</label>
              <select id="priority" name="priority" defaultValue="medium">
                {TICKET_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="route">Page</label><input id="route" name="route_shown" defaultValue={from} readOnly className="mono" placeholder="(not captured)" /></div>
          </div>
          <div className="field"><label htmlFor="description">Description *</label><textarea id="description" name="description" required minLength={3} maxLength={8000} rows={8} /></div>
        </Card>
        <div className="row">
          <button className="button" type="submit">Send report</button>
          <a className="button button-quiet" href="/" style={{ textDecoration: 'none' }}>Cancel</a>
        </div>
      </form>

      <Card title="Your reports" note="The last 20 tickets you filed, with their current status.">
        {mine.length === 0 ? <p className="muted small" style={{ margin: 0 }}>You have not filed a report yet.</p> : (
          <table className="data">
            <thead><tr><th scope="col">Ref</th><th scope="col">Subject</th><th scope="col">Status</th><th scope="col">Filed</th><th scope="col">Last activity</th></tr></thead>
            <tbody>
              {mine.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{ticketRef(t.number)}</td>
                  <td>{t.subject}</td>
                  <td><StatusChip status={t.status} /></td>
                  <td className="mono xs">{t.created_at.slice(0, 10)}</td>
                  <td className="mono xs">{t.last_event_at.slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
