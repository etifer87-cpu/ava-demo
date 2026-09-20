/**
 * Search comparison that ignores case AND accents.
 *
 * Every search box in the product used `ILIKE`, which is case-insensitive and accent-SENSITIVE. On
 * 2026-09-20, walking the demo script, `/sessions?q=Marin Morales` returned zero sessions and
 * `/sessions?q=Marín Morales` returned 21. On this roster that is most of the names.
 *
 * `text_fold` (migration 0160) is IMMUTABLE and indexed, so this stays a trigram index scan rather
 * than a function call per row.
 *
 * Use `LIKE`, not `ILIKE`: both sides are already folded to lower case, and ILIKE on a folded
 * expression would not use the index.
 */

/** `text_fold(<column>) LIKE text_fold($n)` - the accent- and case-insensitive form of `<column> ILIKE $n`. */
export function foldedLike(column: string, param: string): string {
  return `text_fold(${column}) LIKE text_fold(${param})`;
}

/** The same for a list of columns, OR-ed together against one parameter. */
export function foldedLikeAny(columns: readonly string[], param: string): string {
  return columns.map((c) => foldedLike(c, param)).join(' OR ');
}
