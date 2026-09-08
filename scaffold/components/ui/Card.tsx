import type { ReactNode } from 'react';

/**
 * Card - a titled surface. Server component; no interactivity, no state.
 *
 * `note` is where the grain of a figure goes ("per grade event, last 12 months"). A number without
 * its grain is the most reliably misread thing on a dashboard.
 */
export interface CardProps {
  readonly title?: ReactNode;
  readonly note?: ReactNode;
  readonly actions?: ReactNode;
  readonly testId?: string;
  readonly children: ReactNode;
}

export function Card({ title, note, actions, testId, children }: CardProps) {
  return (
    <section className="card" data-testid={testId}>
      {(title || actions) && (
        <div className="row">
          {title ? <h2 className="card-title">{title}</h2> : null}
          <span className="spacer" />
          {actions}
        </div>
      )}
      {note ? <p className="card-note">{note}</p> : null}
      {children}
    </section>
  );
}

export default Card;
