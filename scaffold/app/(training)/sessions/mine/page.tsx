import StubPage from '@/components/ui/StubPage';

/**
 * /sessions/mine - the assessor's own sessions, and the place a new one is started.
 *
 * Separate from /sessions because they answer different questions: /sessions is every session
 * flown (a wide read, managers), this is the sessions the caller is assigned to grade.
 */
// TODO(kit): implement. Specified by docs/04_ETR.md. Gate: training.sessions.grade.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'My sessions' };

export default function Page() {
  return (
    <StubPage
      title="My sessions"
      testId="my-session-list"
      specifiedBy="docs/04_ETR.md"
      gate="training.sessions.grade"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'My sessions' }]}
      summary="The sessions this assessor is assigned to: open, awaiting signature, finalised - and the button that opens a new one."
    />
  );
}
