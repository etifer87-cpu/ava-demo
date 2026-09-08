import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/10_INTEGRATION.md. Gate: planning.schedule.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Planning' };

export default function Page() {
  return (
    <StubPage
      title="Planning"
      testId="planning-overview"
      specifiedBy="docs/10_INTEGRATION.md"
      gate="planning.schedule.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Planning' }]}
      summary="Schedule overview, with rule violations shown inline on the draft rather than at publish time."
    />
  );
}
