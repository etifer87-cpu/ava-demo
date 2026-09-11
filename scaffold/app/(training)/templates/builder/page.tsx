import StubPage from '@/components/ui/StubPage';

// TODO(kit): implement. Specified by docs/05_TEMPLATES_AND_BUILDER.md. Gate: training.templates.configure.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Template builder' };

export default function Page() {
  return (
    <StubPage
      title="Template builder"
      testId="template-builder-stub"
      specifiedBy="docs/05_TEMPLATES_AND_BUILDER.md"
      gate="training.templates.configure"
      crumbs={[{ label: 'Overview', href: '/' }, { label: 'Programs', href: '/templates' }, { label: 'Builder' }]}
      summary="Element builder for a draft version. Elements carry a stable author-assigned element_key; answers reference the key, never the row id."
    />
  );
}
