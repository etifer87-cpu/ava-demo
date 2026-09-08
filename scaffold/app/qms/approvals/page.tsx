import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/08_QMS.md. Gate: qms.approvals.decide.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approvals' };

export default function Page() {
  return (
    <StubPage
      title="Approvals"
      testId="approval-list"
      specifiedBy="docs/08_QMS.md"
      gate="qms.approvals.decide"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Qualifications', href: '/qms/qualifications' }, { label: 'Approvals' }]}
      summary="Submitted-document approval queue."
    />
  );
}
