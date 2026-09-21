import { redirect } from 'next/navigation';
import { brand } from '@/lib/config';
import { noticeApplies, noticeRequired, safeNext } from '@/lib/demo-notice';

/**
 * The acceptance notice shown before the sign-in screen on the deployed demonstration.
 *
 * A plain POST form, like the login page: no client component, no fetch. The box is `required`, so
 * the BROWSER refuses the submit until it is ticked and the button is never greyed out - grey-out
 * would need a client component to hold one boolean, and the server refuses an unticked post
 * anyway. The check that matters is in the route, not in the markup.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Before you continue' };

export default async function DisclaimerPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Not a deployment that shows it, or already accepted: there is nothing to ask.
  if (!noticeApplies()) redirect('/');
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (!(await noticeRequired())) redirect(next);

  const b = brand();

  return (
    <div className="stack" style={{ maxWidth: '40rem', margin: '0 auto' }}>
      {b.logo.path ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={b.logo.path} alt={b.logo.alt || b.product.name} height={b.logo.height_px * 1.5} style={{ alignSelf: 'flex-start' }} />
      ) : null}

      <h1>Before you continue</h1>

      <div className="card stack">
        <p style={{ fontWeight: 600, margin: 0 }}>This is a demonstration system.</p>

        <p className="small" style={{ margin: 0 }}>
          All content, design and code in this system are the property of <strong>Corvanox OÜ</strong>.
          Logos, trade marks and brand imagery belong to their respective owners and are shown with
          permission for this demonstration.
        </p>

        <p className="small" style={{ margin: 0 }}>
          <strong>Nothing here describes a real person.</strong> Every name, record, grade, signature
          and document is synthetic and was generated for this demonstration. Any resemblance to a
          real person is coincidence, and no figure shown relates to that person.
        </p>

        <p className="small" style={{ margin: 0 }}>
          Copying, reproducing, redistributing or reusing the code, the screens or the ideas in this
          system is not permitted.
        </p>
      </div>

      <form className="card stack" method="post" action="/api/disclaimer" data-testid="disclaimer-form">
        <input type="hidden" name="next" value={next} />

        <label className="check">
          <input type="checkbox" name="agree" value="yes" required data-testid="disclaimer-agree" />
          <span>I agree and acknowledge the above</span>
        </label>

        <div className="row" style={{ gap: 'var(--space-3)' }}>
          <button type="submit" className="button" data-testid="disclaimer-continue">Continue</button>
          <a className="button button-quiet" href="/disclaimer/declined" data-testid="disclaimer-cancel">Cancel</a>
        </div>
      </form>
    </div>
  );
}
