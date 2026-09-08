import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/04_ETR.md. Gate: training.sessions.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sessions' };

export default function Page() {
  return (
    <StubPage
      title="Sessions"
      testId="session-list"
      specifiedBy="docs/04_ETR.md"
      gate="training.sessions.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Sessions' }]}
      summary="The grading surface and its list: sessions open, awaiting signature and finalised."
    />
  );
}
