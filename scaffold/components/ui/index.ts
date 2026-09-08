/**
 * components/ui - the shared set the example screens are built from.
 *
 * Server components unless the file says otherwise. Exactly one is a client component and it says
 * why in its header: NavLinks, which needs the current path for `aria-current`.
 *
 * The chart components are NOT re-exported here. They live in components/charts/, take no hooks and
 * a required `id` prop, and are imported directly by the pages that draw them - the same components
 * render on screen and inside the PDF. Charts.tsx, the client boundary they used to need, is
 * retired and empty.
 */
export { AppHeader, type AppHeaderProps } from './AppHeader';
export { NavLinks, type NavItem } from './NavLinks';
export { Breadcrumbs, type Crumb } from './Breadcrumbs';
export { Card, type CardProps } from './Card';
export { Chip, type ChipProps, type ChipTone } from './Chip';
export { DataTable, type Column, type DataTableProps } from './DataTable';
export { FilterBar, TextFilter, SelectFilter, type SelectOption } from './FilterBar';
export { EmptyState } from './EmptyState';
export { ErrorState } from './ErrorState';
