import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/09_DMS.md. Gate: dms.documents.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documents' };

export default function Page() {
  return (
    <StubPage
      title="Documents"
      testId="document-list"
      specifiedBy="docs/09_DMS.md"
      gate="dms.documents.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Documents' }]}
      summary="Folder tree and recent filings. Filing happens server-side; nothing is written from the browser."
    />
  );
}
