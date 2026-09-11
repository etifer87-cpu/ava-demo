import StubPage from '@/components/ui/StubPage';
import { labels } from '@/lib/config';

/**
 * /instructors - assessor analytics: how each assessor grades, against the population.
 *
 * Specified by docs/06_ANALYTICS.md. The capability is scoped and excludes the holder by design:
 * an assessor does not read their own residual here.
 */
// TODO(kit): implement. Gate: training.analytics.assessor.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Instructors' };

export default function Page() {
  return (
    <StubPage
      title={labels().assessor_plural}
      testId="assessor-analytics"
      specifiedBy="docs/06_ANALYTICS.md"
      gate="training.analytics.assessor.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: labels().assessor_plural }]}
      summary="Grading behaviour per assessor against the expected distribution: residual, monthly movement, habits and coverage. The holder is excluded from their own view."
    />
  );
}
