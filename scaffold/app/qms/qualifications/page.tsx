import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/08_QMS.md. Gate: qms.qualifications.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Qualifications' };

export default function Page() {
  return (
    <StubPage
      title="Qualifications"
      testId="qualification-list"
      specifiedBy="docs/08_QMS.md"
      gate="qms.qualifications.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Qualifications' }]}
      summary="Validity dashboard: valid, warning, expired, missing."
    />
  );
}
