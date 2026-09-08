import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/12_ROLES_AND_PERMISSIONS.md.
// The form must require the OLD password even when the change is forced: a forced change that
// skips it turns a borrowed unlocked session into a permanent account takeover.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Change password' };

export default function Page() {
  return (
    <StubPage
      title="Change password"
      testId="change-password"
      specifiedBy="docs/12_ROLES_AND_PERMISSIONS.md"
      gate="session"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Change password' }]}
      summary="Forced first-login and post-reset password change. Requires the old password in every case, including a forced change."
    />
  );
}
