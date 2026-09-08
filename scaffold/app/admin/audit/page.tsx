import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/17_GOVERNANCE.md. Gate: platform.audit.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit log' };

export default function Page() {
  return (
    <StubPage
      title="Audit log"
      testId="audit-log"
      specifiedBy="docs/17_GOVERNANCE.md"
      gate="platform.audit.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Admin' }, { label: 'Audit' }]}
      summary="Append-only audit log with prefix filters: auth. user. record. export."
    />
  );
}
