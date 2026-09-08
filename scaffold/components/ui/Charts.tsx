/**
 * Charts.tsx - RETIRED. This file is deliberately empty.
 *
 * It existed for one reason: the chart components in components/charts/ called React's `useId` to
 * namespace their SVG element ids, a hook cannot run in a React server component, and importing
 * them straight into a server page therefore failed at render. This module carried the
 * `'use client'` directive and re-exported them, so a server page could reach them.
 *
 * That reason is gone. The chart components now take a required `id` prop and derive their element
 * ids deterministically through `chartId()` in components/charts/chart-tokens.ts. They use no hooks
 * at all, so they are genuine server components: import them directly from
 * `@/components/charts/<Name>`, which is what app/(training)/subjects/[id]/page.tsx does.
 *
 * Re-introducing a client boundary here would make the whole chart set client-only again and would
 * take the charts out of the PDF path, where there is no client runtime to run them. If a chart
 * ever needs genuine interactivity, the interactive shell is a NEW client component that wraps a
 * server-rendered chart - not a re-export of the chart itself.
 *
 * The file is kept rather than removed only because this scaffold is distributed as a file set that
 * is added to, never deleted from; nothing imports it.
 */
export {};
