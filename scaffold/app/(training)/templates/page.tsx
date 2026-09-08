import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/05_TEMPLATES_AND_BUILDER.md. Gate: training.templates.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Templates' };

export default function Page() {
  return (
    <StubPage
      title="Templates"
      testId="template-list"
      specifiedBy="docs/05_TEMPLATES_AND_BUILDER.md"
      gate="training.templates.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Templates' }]}
      summary="Form definitions with their versions and publication state."
    />
  );
}
