import type { ReactNode } from 'react';

/**
 * EmptyState - "there is nothing here", said precisely.
 *
 * `reason` is required because the three empty states mean different things and must never look
 * alike: nothing matched the filter, nothing has been recorded yet, or the caller may not see it.
 * A single grey "No data" hides a broken filter for months.
 */
export interface EmptyStateProps {
  readonly title: string;
  readonly reason: string;
  readonly action?: ReactNode;
  readonly testId?: string;
}

export function EmptyState({ title, reason, action, testId }: EmptyStateProps) {
  return (
    <div className="empty" data-testid={testId} data-empty="true">
      <p style={{ color: 'var(--ink)', fontWeight: 600 }}>{title}</p>
      <p className="small">{reason}</p>
      {action}
    </div>
  );
}

export default EmptyState;
