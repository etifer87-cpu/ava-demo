import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/08_QMS.md. Gate: qms.events.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Qualification events' };

export default function Page() {
  return (
    <StubPage
      title="Qualification events"
      testId="qms-event-list"
      specifiedBy="docs/08_QMS.md"
      gate="qms.events.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Qualifications', href: '/qms/qualifications' }, { label: 'Events' }]}
      summary="The QMS event timeline: every grant, expiry, suspension and reinstatement, in order."
    />
  );
}
