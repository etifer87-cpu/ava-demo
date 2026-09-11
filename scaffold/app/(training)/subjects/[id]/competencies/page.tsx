import StubPage from '@/components/ui/StubPage';
import { labels } from '@/lib/config';

// TODO(kit): implement. Specified by docs/06_ANALYTICS.md. Gate: training.analysis.view, row-checked with requireOnPerson.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Competencies' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <StubPage
      title="Competencies"
      testId="subject-competencies"
      specifiedBy="docs/06_ANALYTICS.md"
      gate="training.analysis.view"
      crumbs={[
        { label: 'Overview', href: '/' },
        { label: labels().subject_plural, href: '/subjects' },
        { label: 'Subject', href: `/subjects/${id}` },
        { label: 'Competencies' },
      ]}
      summary="Per-competency profile, screening index and trend for one subject, against their own recent window."
    />
  );
}
