import StubPage from '@/components/ui/StubPage';
import { labels } from '@/lib/config';

// TODO(kit): implement. Specified by docs/04_ETR.md. Gate: training.records.view, row-checked with requireOnPerson.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Records' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <StubPage
      title="Records"
      testId="subject-records"
      specifiedBy="docs/04_ETR.md"
      gate="training.records.view"
      crumbs={[
        { label: 'Overview', href: '/' },
        { label: labels().subject_plural, href: '/subjects' },
        { label: 'Subject', href: `/subjects/${id}` },
        { label: 'Records' },
      ]}
      summary="One pilot’s records grouped by kind of training or check. Their profile already lists every record with its report; this screen would add the grouping."
    />
  );
}
