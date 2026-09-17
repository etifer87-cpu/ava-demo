import Link from 'next/link';

/**
 * app/forbidden.tsx - what an account sees when it opens a screen it does not hold.
 *
 * Rendered by `forbidden()` from next/navigation, reached through `requirePageCapability`. It is a
 * REFUSAL, not a failure: nothing went wrong, the account simply does not hold the capability that
 * screen is built on. So it says that, and it does not invite a retry, because retrying is not what
 * fixes it.
 *
 * What it deliberately does not say: the capability code. The person reading this cannot grant it to
 * themselves, the code describes our permission model rather than their problem, and naming it turns
 * a refusal into a map of the system for anyone who goes looking. It is in the server log instead,
 * where the person who CAN grant it is already looking.
 */
export default function Forbidden() {
  return (
    <div className="stack" style={{ maxWidth: '44rem' }} data-testid="forbidden">
      <h1 style={{ margin: 0 }}>This screen is not open to your account</h1>
      <p className="small" style={{ margin: 0 }}>
        Your roles do not include this one. That is a permission, not a fault: nothing failed and
        nothing was lost.
      </p>
      <p className="small" style={{ margin: 0 }}>
        If you need it, ask an administrator to add the role that carries it. They can see exactly
        which one from the server log, and grant it on your account page.
      </p>
      <p style={{ margin: 0 }}>
        <Link href="/">Back to the overview</Link>
      </p>
    </div>
  );
}
