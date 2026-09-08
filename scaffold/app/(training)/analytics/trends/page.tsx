import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/07_VISUALISATION.md. Gate: training.analytics.programme.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Trends' };

export default function Page() {
  return (
    <StubPage
      title="Trends"
      testId="trend-charts"
      specifiedBy="docs/07_VISUALISATION.md"
      gate="training.analytics.programme.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Analytics', href: '/analytics' }, { label: 'Trends' }]}
      summary="Small-multiple trend grid over periods, with suppressed periods left absent rather than zero-filled."
    />
  );
}
