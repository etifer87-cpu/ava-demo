import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/06_ANALYTICS.md. Gate: training.analytics.programme.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Analytics' };

export default function Page() {
  return (
    <StubPage
      title="Analytics"
      testId="analytics-overview"
      specifiedBy="docs/06_ANALYTICS.md"
      gate="training.analytics.programme.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Analytics' }]}
      summary="Programme indicators over a frozen calendar base, read from a pre-computed cache."
    />
  );
}
