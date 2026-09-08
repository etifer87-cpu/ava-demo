import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/17_GOVERNANCE.md. Gate: platform.tickets.triage.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Support tickets' };

export default function Page() {
  return (
    <StubPage
      title="Support tickets"
      testId="ticket-list"
      specifiedBy="docs/17_GOVERNANCE.md"
      gate="platform.tickets.triage"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin/people' }, { label: 'Tickets' }]}
      summary="Support ticket triage."
    />
  );
}
