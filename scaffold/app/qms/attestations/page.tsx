import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/08_QMS.md. Gate: qms.attestations.sign.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Attestations' };

export default function Page() {
  return (
    <StubPage
      title="Attestations"
      testId="attestation-list"
      specifiedBy="docs/08_QMS.md"
      gate="qms.attestations.sign"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Qualifications', href: '/qms/qualifications' }, { label: 'Attestations' }]}
      summary="Compliance attestations and their signatures."
    />
  );
}
