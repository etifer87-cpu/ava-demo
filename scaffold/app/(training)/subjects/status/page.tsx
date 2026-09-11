import StubPage from '@/components/ui/StubPage';
import { labels } from '@/lib/config';

/**
 * /subjects/status - training status across the roster: who is current, who is due, who is overdue.
 *
 * A static segment beside /subjects/[id]; Next resolves static before dynamic, so this never
 * reaches the profile route. Specified by docs/06_ANALYTICS.md (currency and coverage).
 */
// TODO(kit): implement. Gate: training.records.view.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Training status' };

export default function Page() {
  return (
    <StubPage
      title="Training status"
      testId="subject-status"
      specifiedBy="docs/06_ANALYTICS.md"
      gate="training.records.view"
      crumbs={[{ label: 'Overview', href: '/' }, { label: labels().subject_plural, href: '/subjects' }, { label: 'Training status' }]}
      summary={`Currency and due dates for every ${labels().subject.toLowerCase()} on the roster: current, due within the window, overdue - read from the currency cache, never recomputed per row.`}
    />
  );
}
