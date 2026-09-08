import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/08_QMS.md. Gate: qms.qualtypes.configure.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Qualification types' };

export default function Page() {
  return (
    <StubPage
      title="Qualification types"
      testId="qualtype-list"
      specifiedBy="docs/08_QMS.md"
      gate="qms.qualtypes.configure"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Qualifications', href: '/qms/qualifications' }, { label: 'Types' }]}
      summary="Qualification type catalogue with validity and warning windows. Windows are configuration, never constants in a query."
    />
  );
}
