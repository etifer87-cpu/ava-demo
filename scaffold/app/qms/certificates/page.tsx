import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/08_QMS.md. Gate: training.certificates.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Completion certificates' };

export default function Page() {
  return (
    <StubPage
      title="Completion certificates"
      testId="certificate-list"
      specifiedBy="docs/08_QMS.md"
      gate="training.certificates.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Qualifications', href: '/qms/qualifications' }, { label: 'Certificates' }]}
      summary="Completion certificates. A hard-gated capability: it can be conferred only by a role in the published matrix, never by exception."
    />
  );
}
