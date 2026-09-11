'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * NavLinks - the only navigational client component in the shell.
 *
 * It is a client component for two reasons and no others: `aria-current="page"` needs the current
 * path, which a server layout cannot know, and a group of links has to open and close.
 *
 * THE LIST ARRIVES ALREADY FILTERED. The server decided, per caller, which groups and which
 * children exist; a link the caller may not follow is not rendered here, not hidden by CSS and not
 * disabled. A group whose children were all filtered away never reaches this file. This component
 * only draws what it was given.
 */
export interface NavItem {
  readonly href: string;
  readonly label: string;
}

/** A top-level entry: either a link, or a label with children (a dropdown). */
export interface NavEntry {
  readonly label: string;
  /** Set when the entry is itself a link. Mutually exclusive with `children`. */
  readonly href?: string;
  readonly children?: readonly NavItem[];
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks({ items, reportHref = null }: { readonly items: readonly NavEntry[]; readonly reportHref?: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  // A menu that survives the navigation it caused is a menu covering the page you asked for.
  useEffect(() => { setOpen(null); }, [pathname]);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <nav className="app-nav" aria-label="Modules" ref={navRef}>
      {items.map((entry) => {
        if (!entry.children || entry.children.length === 0) {
          const href = entry.href ?? '/';
          return (
            <Link key={href} href={href} aria-current={isActive(pathname, href) ? 'page' : undefined}>
              {entry.label}
            </Link>
          );
        }
        const active = entry.children.some((c) => isActive(pathname, c.href));
        const isOpen = open === entry.label;
        return (
          <div key={entry.label} className="nav-group" data-testid={`nav-group-${entry.label.toLowerCase().replace(/\s+/g, '-')}`}>
            <button
              type="button"
              className="nav-group-button"
              aria-expanded={isOpen}
              aria-current={active ? 'page' : undefined}
              onClick={() => setOpen(isOpen ? null : entry.label)}
            >
              {entry.label}
              <span aria-hidden="true" className="nav-caret">▾</span>
            </button>
            {isOpen ? (
              <div className="nav-menu" role="menu">
                {entry.children.map((child) => (
                  <Link key={child.href} href={child.href} role="menuitem" aria-current={isActive(pathname, child.href) ? 'page' : undefined}>
                    {child.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
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
