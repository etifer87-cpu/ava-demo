import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/12_ROLES_AND_PERMISSIONS.md. Gate: people.manage.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'People administration' };

export default function Page() {
  return (
    <StubPage
      title="People administration"
      testId="people-admin"
      specifiedBy="docs/12_ROLES_AND_PERMISSIONS.md"
      gate="people.manage"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Admin' }, { label: 'People' }]}
      summary="Roster maintenance. Roles are a separate page and a separate route from the profile, deliberately."
    />
  );
}
