import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/12_ROLES_AND_PERMISSIONS.md. Gate: platform.roles.assign.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Roles and capabilities' };

export default function Page() {
  return (
    <StubPage
      title="Roles and capabilities"
      testId="role-matrix"
      specifiedBy="docs/12_ROLES_AND_PERMISSIONS.md"
      gate="platform.roles.assign"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin/people' }, { label: 'Roles' }]}
      summary="The role by capability matrix, read-only, generated from the database rather than restated in code."
    />
  );
}
