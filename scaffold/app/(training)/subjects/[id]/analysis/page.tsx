import StubPage from '@/components/ui/StubPage';
import { labels } from '@/lib/config';

// TODO(kit): implement. Specified by docs/11_AI_PIPELINE.md. Gate: training.analysis.view, row-checked with requireOnPerson.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Analysis' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <StubPage
      title="Analysis"
      testId="subject-analysis"
      specifiedBy="docs/11_AI_PIPELINE.md"
      gate="training.analysis.view"
      crumbs={[
        { label: 'Overview', href: '/' },
        { label: labels().subject_plural, href: '/subjects' },
        { label: 'Subject', href: `/subjects/${id}` },
        { label: 'Analysis' },
      ]}
      summary="Analysis runs: the deterministic figure set, the narrative generated from it, and the record sources it cites. In degraded mode the figures render and the narrative is absent."
    />
  );
}
