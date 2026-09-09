import type { Metadata } from 'next';
import './globals.css';
import { brand, brandCss } from '@/lib/config';
import { getSession } from '@/lib/session';
import { resolveAccess, can } from '@/lib/access';
import AppHeader from '@/components/ui/AppHeader';
import type { NavItem } from '@/components/ui/NavLinks';

/**
 * Root layout - the app shell.
 *
 * Three things happen here and nowhere else:
 *
 * 1. THE TOKEN BLOCK. config/brand.yaml is read on the server and written into a <style> element
 *    on :root, after globals.css, so an operator's palette overrides the neutral defaults. This is
 *    the whole of "applying a brand": one YAML file, no component edits. docs/13_DESIGN_SYSTEM.md.
 *
 * 2. THE NAVIGATION IS FILTERED BY CAPABILITY, SERVER-SIDE. A module the caller cannot enter is
 *    NOT RENDERED - not greyed out, not disabled. The route itself re-checks; this is presentation,
 *    the gate is in the handler.
 *
 * 3. THE SHELL MARKER. `data-app-shell="ready"` is what scripts/smoke-screens.mjs looks for to
 *    decide a page actually rendered. A 200 with a half-rendered body would otherwise pass.
 */

export const runtime = 'nodejs';         // reads cookies and the filesystem
export const dynamic = 'force-dynamic';  // every page is per-caller; nothing here may be cached

export async function generateMetadata(): Promise<Metadata> {
  const b = brand();
  return {
    title: { default: b.product.name, template: `%s - ${b.product.short_name}` },
    description: 'Competency-based training management.',
    robots: { index: false, follow: false },
  };
}

/** Module -> the capability that must be held for its entry to appear. */
const MODULES: ReadonlyArray<NavItem & { capability: string }> = [
  { href: '/subjects', label: 'Subjects', capability: 'people.view' },
  { href: '/sessions', label: 'Sessions', capability: 'training.sessions.view' },
  { href: '/records', label: 'Records', capability: 'training.records.view' },
  { href: '/templates', label: 'Templates', capability: 'training.templates.view' },
  { href: '/analytics', label: 'Analytics', capability: 'training.analytics.programme.view' },
  { href: '/qms/qualifications', label: 'Qualifications', capability: 'qms.qualifications.view' },
  { href: '/dms/documents', label: 'Documents', capability: 'dms.documents.view' },
  // The admin area opens for anyone who may READ the account directory: the operator's
  // administrator, the head of training and the training manager (docs/12; migrations 0142-0143).
  // Each page inside re-checks its own, narrower capability.
  { href: '/admin', label: 'Admin', capability: 'platform.users.view' },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const b = brand();
  const session = await getSession();

  let nav: NavItem[] = [];
  if (session) {
    const access = await resolveAccess(session);
    nav = MODULES.filter((m) => can(access, m.capability)).map(({ href, label }) => ({ href, label }));
  }

  return (
    <html lang="en">
      <head>
        {/* After globals.css, so brand.yaml wins over the neutral defaults. */}
        <style dangerouslySetInnerHTML={{ __html: brandCss(b) }} />
      </head>
      <body data-app-shell="ready">
        <AppHeader
          productName={b.product.name}
          shortName={b.product.short_name}
          environmentLabel={b.product.environment_label}
          logo={b.logo.path ? { path: b.logo.path, alt: b.logo.alt, heightPx: b.logo.height_px } : null}
          nav={nav}
          identityLabel={session ? (session.fullName ?? session.username) : null}
          reportHref={session ? '/support/report' : null}
        />
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
