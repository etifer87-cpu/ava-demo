import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/09_DMS.md. Gate: dms.documents.upload.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Upload' };

export default function Page() {
  return (
    <StubPage
      title="Upload"
      testId="document-upload"
      specifiedBy="docs/09_DMS.md"
      gate="dms.documents.upload"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Documents', href: '/dms/documents' }, { label: 'Upload' }]}
      summary="Staging upload. Filing happens server-side, so an interrupted upload never files a partial document."
    />
  );
}
