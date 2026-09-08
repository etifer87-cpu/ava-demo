import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/15_DEPLOYMENT.md. Gate: platform.config.manage.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Configuration' };

export default function Page() {
  return (
    <StubPage
      title="Configuration"
      testId="config-admin"
      specifiedBy="docs/15_DEPLOYMENT.md"
      gate="platform.config.manage"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Admin' }, { label: 'Configuration' }]}
      summary="Config versions: what is active, and what a bump would change."
    />
  );
}
