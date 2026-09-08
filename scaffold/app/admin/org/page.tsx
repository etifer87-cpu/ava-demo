import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/02_DATA_MODEL.md. Gate: people.manage.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Org units and asset classes' };

export default function Page() {
  return (
    <StubPage
      title="Org units and asset classes"
      testId="org-admin"
      specifiedBy="docs/02_DATA_MODEL.md"
      gate="people.manage"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin/people' }, { label: 'Org' }]}
      summary="Org units and asset classes. A person's asset class is their CURRENT one; a record freezes the one it was flown on."
    />
  );
}
