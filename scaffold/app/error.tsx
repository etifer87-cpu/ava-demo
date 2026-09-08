'use client';

/**
 * The root error boundary. A client component by requirement of the App Router.
 *
 * It renders `data-error-boundary="true"`, which scripts/smoke-screens.mjs treats as a failure
 * marker: this page returned 200 and did not work. Never remove that attribute to quieten a smoke
 * run - the run is the only thing standing between a broken screen and an auditor finding it.
 *
 * The message is never the raw error. A stack trace on a screen is an information leak and tells a
 * user nothing they can act on; the digest is enough to find the entry in the server log.
 */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="errorstate" data-error-boundary="true" role="alert">
      <p style={{ fontWeight: 600 }}>This page could not be rendered.</p>
      <p className="small">
        The failure is recorded in the server log. Quote this reference:{' '}
        <span className="mono">{error.digest ?? 'no-digest'}</span>
      </p>
      <button className="button" type="button" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
