import Breadcrumbs, { type Crumb } from './Breadcrumbs';

/**
 * StubPage - the one and only way a route that is not built yet is presented.
 *
 * A stub is a VALID module that renders a truthful screen: it names the route, the capability that
 * will gate it, and the doc that specifies it. It never renders a fake chart, a placeholder table
 * or lorem text, because a convincing-looking screen with no data behind it is how a demo becomes
 * a commitment.
 *
 * It carries the route's real `data-testid` so scripts/smoke-screens.mjs exercises the route now
 * and keeps exercising it after it is implemented.
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
    <div className="stack" data-testid={testId} data-stub="true">
      <Breadcrumbs items={crumbs} />
      <h1>{title}</h1>
      <div className="notice">
        <p style={{ fontWeight: 600, margin: 0 }}>Not built in this scaffold.</p>
        <p className="small" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>
          {summary}
        </p>
        <p className="small" style={{ marginBottom: 0 }}>
          Specified by <span className="mono">{specifiedBy}</span>. The implementation must check{' '}
          <span className="mono">{gate}</span> server-side before it reads anything.
        </p>
      </div>
    </div>
  );
}

export default StubPage;
