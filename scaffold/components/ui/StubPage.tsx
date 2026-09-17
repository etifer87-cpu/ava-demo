import Breadcrumbs, { type Crumb } from './Breadcrumbs';

/**
 * StubPage - the one and only way a route that is not built yet is presented.
 *
 * A stub renders a truthful screen and never a fake one: no placeholder chart, no lorem table, no
 * empty grid that looks like it is waiting for data. A convincing-looking screen with nothing
 * behind it is how a demonstration becomes a commitment.
 *
 * WHAT IT SAYS, AND TO WHOM. This page is read by the operator, not by us. It used to open with
 * "Not built in this scaffold" over the route's internal specification and capability code - three
 * sentences addressed to the developer, shown to a chief pilot, and leaking the name of the kit
 * the product is built on. It now says what a customer needs: this part is the next phase, here is
 * what it will do, and nothing you have been shown depends on it.
 *
 * The specification and the gate are still carried, as data attributes rather than text: the smoke
 * run and anyone reading the DOM can find them, and nobody in a meeting has to.
 */
export interface StubPageProps {
  readonly title: string;
  readonly testId: string;
  /** The doc that specifies this route, by filename. Cross-reference by filename, never by number. */
  readonly specifiedBy: string;
  /** The capability the finished route must check server-side. */
  readonly gate: string;
  readonly crumbs: readonly Crumb[];
  readonly summary: string;
}

export function StubPage({ title, testId, specifiedBy, gate, crumbs, summary }: StubPageProps) {
  return (
    <div
      className="stack"
      data-testid={testId}
      data-stub="true"
      data-specified-by={specifiedBy}
      data-gate={gate}
    >
      <Breadcrumbs items={crumbs} />
      <h1>{title}</h1>
      <div className="notice">
        <p style={{ fontWeight: 600, margin: 0 }}>This module is the next phase.</p>
        <p className="small" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>
          {summary}
        </p>
        <p className="small" style={{ marginBottom: 0 }}>
          It is not part of what is being demonstrated, and nothing you have seen depends on it.
        </p>
      </div>
    </div>
  );
}

export default StubPage;
