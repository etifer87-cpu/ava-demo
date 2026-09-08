import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/06_ANALYTICS.md. Gate: training.analytics.programme.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Competency matrix' };

export default function Page() {
  return (
    <StubPage
      title="Competency matrix"
      testId="competency-matrix"
      specifiedBy="docs/06_ANALYTICS.md"
      gate="training.analytics.programme.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Analytics', href: '/analytics' }, { label: 'Competencies' }]}
      summary="Per-competency distributions keyed by competency_id, never by name."
    />
  );
}
