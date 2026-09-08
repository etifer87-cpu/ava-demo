import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/12_ROLES_AND_PERMISSIONS.md. Gate: platform.users.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accounts' };

export default function Page() {
  return (
    <StubPage
      title="Accounts"
      testId="user-list"
      specifiedBy="docs/12_ROLES_AND_PERMISSIONS.md"
      gate="platform.users.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Admin', href: '/admin/people' }, { label: 'Accounts' }]}
      summary="Login accounts. An account and a roster row are separate objects: leaving the organisation and losing a login are different events."
    />
  );
}
