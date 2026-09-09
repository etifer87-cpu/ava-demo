'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * NavLinks - the only client component in the shell, and it is a client component for exactly one
 * reason: `aria-current="page"` needs the current path, and a layout server component cannot know
 * it. Nothing else here is interactive.
 *
 * The item list arrives ALREADY FILTERED by the server against the caller's capabilities. A link
 * the caller may not follow is not rendered here, not hidden by CSS and not disabled: the server
 * decided, and this component only draws what it was given.
 */
export interface NavItem {
  readonly href: string;
  readonly label: string;
}

export function NavLinks({ items, reportHref = null }: { readonly items: readonly NavItem[]; readonly reportHref?: string | null }) {
  const pathname = usePathname();
  return (
    <nav className="app-nav" aria-label="Modules">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>
            {item.label}
          </Link>
        );
      })}
      {reportHref ? (
        // The tech-log intake, carrying the page the reporter is on. Rendered here, not in the
        // server header, for the same single reason this file is a client component: the path.
        <Link href={`${reportHref}?from=${encodeURIComponent(pathname)}`} className="app-report" title="Report a problem with the application" aria-current={pathname.startsWith(reportHref) ? 'page' : undefined}>
          Report a problem
        </Link>
      ) : null}
    </nav>
  );
}

export default NavLinks;
