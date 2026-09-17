import type { Metadata } from 'next';
import './globals.css';
import { brand, brandCss, labels } from '@/lib/config';
import { getSession } from '@/lib/session';
import { resolveAccess, can, scopesFor, type ResolvedAccess } from '@/lib/access';
import AppHeader from '@/components/ui/AppHeader';
import type { NavEntry, NavItem } from '@/components/ui/NavLinks';

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
 *    NOT RENDERED - not greyed out, not disabled. A group whose every child was filtered away is
 *    not rendered either. The route itself re-checks; this is presentation, the gate is in the
 *    handler.
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

/** A nav entry is visible when this returns true. One predicate, evaluated per caller. */
type Visible = (access: ResolvedAccess) => boolean;

/** Holds the capability at all. */
const held = (capability: string): Visible => (a) => can(a, capability);

/**
 * Holds the capability at a scope that reaches beyond the caller's own assignments. This is the
 * difference between "the sessions I am on" and "every session flown": the kit has no "is a
 * manager" flag, and inventing one would put the same fact in two places. The scope on the grant
 * IS the fact.
 */
const heldWidely = (capability: string): Visible => (a) =>
  scopesFor(a, capability).some((s) => s === 'org' || s === 'all');

interface NavChildSpec extends NavItem { readonly visible: Visible }
interface NavGroupSpec { readonly label: string; readonly href?: string; readonly children?: readonly NavChildSpec[]; readonly visible?: Visible }

/**
 * The navigation, as the operator reads it.
 *
 * The roster's label is the operator's word (policy.yaml `labels.subject_plural`), not a literal:
 * the route and every id stay `/subjects` because they are identifiers, and only what a person
 * reads changes. Evaluated at module load, which is when policy.yaml is read anyway.
 *
 * Routes that exist but are not in this list (Records, Documents) are reached from the screens that
 * own them, not from the header. A nav bar is a set of starting points, not an index - and the
 * training picture IS a starting point, which is why it leads the list rather than being reached
 * from a tile: it is the screen a head of training opens first and returns to.
 */
const NAV: readonly NavGroupSpec[] = [
  // The manager's landing. An instructor does not hold this capability and never sees the entry.
  { label: 'Training picture', href: '/analytics', visible: held('training.analytics.programme.view') },
  {
    label: labels().subject_plural,
    children: [
      { href: '/subjects',        label: 'Trainees',        visible: held('people.view') },
      { href: '/subjects/status', label: 'Training status', visible: held('training.records.view') },
      { href: '/instructors',     label: labels().assessor_plural, visible: held('training.analytics.assessor.view') },
    ],
  },
  {
    label: 'Programs',
    children: [
      // Authoring the programme: templates, versions, the builder. Managers only.
      { href: '/templates',    label: 'Builder',     visible: held('training.templates.configure') },
      // Every session flown, by anyone - a wide read, so a wide scope is required.
      { href: '/sessions',     label: 'Sessions',    visible: heldWidely('training.sessions.view') },
      // The instructor's own: what they are assigned to, and starting a new one. Anyone who grades.
      { href: '/sessions/mine', label: 'My sessions', visible: held('training.sessions.grade') },
    ],
  },
  { label: 'Qualifications', href: '/qms/qualifications', visible: held('qms.qualifications.view') },
  // The admin area opens for anyone who may READ the account directory: the operator's
  // administrator, the head of training and the training manager (docs/12; migrations 0142-0143).
  // Each page inside re-checks its own, narrower capability.
  { label: 'Admin', href: '/admin', visible: held('platform.users.view') },
];

function navFor(access: ResolvedAccess): NavEntry[] {
  const out: NavEntry[] = [];
  for (const entry of NAV) {
    if (entry.children) {
      const children = entry.children.filter((c) => c.visible(access)).map(({ href, label }) => ({ href, label }));
      if (children.length > 0) out.push({ label: entry.label, children });
      continue;
    }
    if (entry.href && (!entry.visible || entry.visible(access))) out.push({ label: entry.label, href: entry.href });
  }
  return out;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const b = brand();
  const session = await getSession();

  let nav: NavEntry[] = [];
  if (session) {
    const access = await resolveAccess(session);
    nav = navFor(access);
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
        {/* In the ROOT layout, so every page carries it without any page knowing it exists - and so
            a page added later cannot forget it. The string is brand.yaml's: an empty vendor_line
            hides the footer, which is what a white-label deployment sets. */}
        {b.product.vendor_line ? (
          <footer className="app-footer">
            <p>{b.product.vendor_line}</p>
          </footer>
        ) : null}
      </body>
    </html>
  );
}
