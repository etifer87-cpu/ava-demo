import Link from 'next/link';
import { requireSession } from '@/lib/session';
import { resolveAccess, requireCapability, visiblePersonIds, ALL_PEOPLE } from '@/lib/access';
import { queryOne } from '@/lib/db';
import { labels, policy } from '@/lib/config';
import { eligiblePrograms, subjectOptions, deviceOptions, heldRoleCodes } from '@/lib/sessions';
import Breadcrumbs from '@/components/ui/Breadcrumbs';
import Card from '@/components/ui/Card';
import Chip from '@/components/ui/Chip';
import NewSessionForm from '@/components/program/NewSessionForm';

/**
 * /sessions/new - open a session against a published program.
 *
 * Everything offered here is already filtered server-side (lib/sessions.ts): published versions only,
 * the programs whose `allowed_assessor_roles` this account's platform roles satisfy, and the fleets
 * their grant is bound to. The POST re-checks all three against the database rather than trusting
 * the form - the form is a mirror of the rules, never their enforcement.
 *
 * Two vocabularies meet on this page and must not be confused. `allowed_assessor_roles` holds
 * PLATFORM ROLE CODES (instructor, examiner, ground_instructor, assessment_manager - policy.yaml
 * assessor_role_codes), which live in user_roles.role_code and decide eligibility.
 * people.instructor_roles holds AVIATION QUALIFICATIONS (TRI, TRE, SFI, LTC, CRMI, GI), which are
 * shown here as information about the instructor and grant nothing by themselves.
 *
 * The device is chosen here, not in the program: one EBT module is flown in whichever simulator is
 * free, and binding a device into a program would mean a version per device.
 *
 * Gate: training.sessions.create.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'New session' };

function one(v: string | string[] | undefined): string { return typeof v === 'string' ? v.trim() : ''; }

export default async function NewSessionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const access = await resolveAccess(session);
  requireCapability(access, 'training.sessions.create');
  const L = labels();
  const P = policy();
  const sp = await searchParams;
  const problem = one(sp.problem);

  const me = session.personId
    ? await queryOne<{ id: string; full_name: string; instructor_roles: string[]; fleet: string | null }>(
        `SELECT p.id, p.full_name, p.instructor_roles, ac.code AS fleet
           FROM people p LEFT JOIN asset_classes ac ON ac.id = p.asset_class_id
          WHERE p.id = $1::uuid AND p.deleted_at IS NULL`, [session.personId])
    : null;

  if (!me) {
    return (
      <div className="stack" data-testid="session-new">
        <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Sessions', href: '/sessions' }, { label: 'New' }]} />
        <h1 style={{ margin: 0 }}>New session</h1>
        <div className="notice notice-warn">
          <p style={{ margin: 0 }}>
            This account is not linked to a roster row, so it cannot be named as the instructor on a
            session. An administrator can link it on the account page.
          </p>
        </div>
      </div>
    );
  }

  const quals = me.instructor_roles ?? [];
  const roleCodes = await heldRoleCodes(session.userId);
  const visible = await visiblePersonIds(access, 'people.view');
  const [programs, devices, subjects] = await Promise.all([
    eligiblePrograms(access, roleCodes),
    deviceOptions(),
    subjectOptions(visible === ALL_PEOPLE ? null : visible, null, '', 400),
  ]);

  return (
    <div className="stack" data-testid="session-new">
      <Breadcrumbs items={[{ label: 'Overview', href: '/' }, { label: 'Sessions', href: '/sessions' }, { label: 'New' }]} />
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>New session</h1>
        <span className="xs muted">conducted by {me.full_name}</span>
        <span className="mono xs">{quals.join(' ') || 'no instructor qualification recorded'}</span>
        <span className="spacer" />
        <Link href="/sessions/mine" className="button button-quiet" style={{ textDecoration: 'none' }}>My sessions</Link>
      </div>

      {problem ? <div className="notice notice-bad" role="status"><p style={{ margin: 0 }}>{problem}</p></div> : null}

      {programs.length === 0 ? (
        <div className="notice notice-warn">
          <p style={{ margin: 0 }}>
            No published program is open to you. A program names the roles that may conduct it
            {roleCodes.length ? <> — this account holds <span className="mono">{roleCodes.join(' ')}</span></> : ', and this account holds no role'}.
            A draft cannot be flown at all; it has to be published first.
          </p>
        </div>
      ) : (
        <Card title="The session" note="Only published programs your roles and fleet allow are listed. Every rule here is checked again when the session is created.">
          <NewSessionForm
            programs={programs}
            devices={devices}
            subjects={subjects}
            seatRoles={P.seats.subject_roles}
            defaultSeatRole={P.seats.default_subject_role}
            today={new Date().toISOString().slice(0, 10)}
            subjectLabel={L.subject}
          />
        </Card>
      )}

      <Card title="What happens next">
        <p className="small" style={{ margin: 0 }}>
          The session opens <strong>{'open'}</strong> and nothing is recorded yet. Grading it writes grades as
          you click them; the first signature by either party locks everything, and finalising freezes a
          record that no longer depends on the program version. A session dated ahead is a planned
          session — it is what the training-status board reads as “next”, and it can be graded when the day comes.
        </p>
        <p className="small" style={{ margin: 'var(--space-2) 0 0' }}>
          Naming a second pilot opens a <strong>crew session</strong>: one session, flown once, with a
          record each. Every element is graded per pilot in the seat they flew, the instructor signs
          once and that signature freezes both records — each against its own content, because the two
          pilots earned different grades. Leave the second pilot empty and nothing changes.
        </p>
      </Card>
    </div>
  );
}
