import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/09_DMS.md. Gate: dms.retention.configure.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Retention' };

export default function Page() {
  return (
    <StubPage
      title="Retention"
      testId="retention-rules"
      specifiedBy="docs/09_DMS.md"
      gate="dms.retention.configure"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Documents', href: '/dms/documents' }, { label: 'Retention' }]}
      summary="Retention rules and their review dates. Deletion is soft everywhere; a retention rule schedules a review, not a purge."
    />
  );
}
