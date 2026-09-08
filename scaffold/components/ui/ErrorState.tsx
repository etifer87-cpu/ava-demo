import type { ReactNode } from 'react';

/**
 * ErrorState - a failure, shown as a failure.
 *
 * It carries `data-error-boundary="true"`, which scripts/smoke-screens.mjs treats as a FORBIDDEN
 * marker: a page that rendered this returned 200 and still failed, and the smoke run must catch
 * that rather than counting the status code. Do not add this attribute to anything that is not an
 * error, and do not remove it to make a smoke run pass.
 */
export interface ErrorStateProps {
  readonly title: string;
  readonly detail?: string;
  readonly hint?: ReactNode;
}

export function ErrorState({ title, detail, hint }: ErrorStateProps) {
  return (
    <div className="errorstate" data-error-boundary="true" role="alert">
      <p style={{ fontWeight: 600 }}>{title}</p>
      {detail ? <p className="small mono">{detail}</p> : null}
      {hint ? <p className="small muted">{hint}</p> : null}
    </div>
  );
}

export default ErrorState;
