import NavLinks, { type NavItem } from './NavLinks';

/**
 * AppHeader - product mark, module navigation, acting identity, sign out.
 *
 * Server component. It receives an already-filtered nav list: see NavLinks. The product name, the
 * mark and every colour come from config/brand.yaml through the token block on :root - there is no
 * operator identity in this file, and applying one is an edit to that YAML alone.
 *
 * Sign out is a POST form, not a link. A GET that ends a session is a session that a prefetching
 * browser or a link scanner can end for you.
 */
export interface AppHeaderProps {
  readonly productName: string;
  readonly shortName: string;
  readonly environmentLabel?: string;
  readonly logo?: { readonly path: string; readonly alt: string; readonly heightPx: number } | null;
  readonly nav: readonly NavItem[];
  /** Display name of the acting user, or null when signed out. */
  readonly identityLabel: string | null;
  /** Where "Report a problem" goes (the tech log intake), or null to hide it. */
  readonly reportHref?: string | null;
}

export function AppHeader({
  productName,
  shortName,
  environmentLabel,
  logo,
  nav,
  identityLabel,
  reportHref,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <a href="/" className="app-mark" aria-label={`${productName} home`}>
          {logo && logo.path ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo.path} alt={logo.alt || productName} height={logo.heightPx} />
          ) : (
            shortName
          )}
        </a>
        {environmentLabel ? (
          <span className="chip" title="Deployment environment">
            {environmentLabel}
          </span>
        ) : null}

        {nav.length > 0 || reportHref ? <NavLinks items={nav} reportHref={reportHref ?? null} /> : null}

        <span className="spacer" />

        {identityLabel ? (
          <>
            <span className="small" data-testid="identity">
              {identityLabel}
            </span>
            <form method="post" action="/api/auth/logout">
              <button className="button button-quiet" type="submit">
                Sign out
              </button>
            </form>
          </>
        ) : null}
      </div>
    </header>
  );
}

export default AppHeader;
