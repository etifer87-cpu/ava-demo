import type { ReactNode } from 'react';
import EmptyState from './EmptyState';

/**
 * DataTable - the one table in the platform. Server component.
 *
 * Conventions it enforces, so that no screen invents its own (docs/13_DESIGN_SYSTEM.md section 8):
 *   - a real <caption>, so the table announces what it holds;
 *   - numeric columns right-aligned, tabular-lining, monospaced, so digits line up down the column;
 *   - an explicit empty state rather than a headed table with no rows, which reads as a bug;
 *   - the row count printed in the caption, because "is this everything?" is the first question
 *     anyone asks of a filtered list.
 *
 * There is no client-side sorting. Sorting is a URL parameter handled in SQL: a sort the server
 * did not do is a sort of the current page only, and it silently lies on page two.
 */
export interface Column<Row> {
  readonly key: string;
  readonly head: ReactNode;
  /** Right-aligned, monospaced, tabular figures. */
  readonly numeric?: boolean;
  readonly cell: (row: Row) => ReactNode;
  /** Column header link target, for a server-side sort. */
  readonly sortHref?: string;
}

export interface DataTableProps<Row> {
  readonly caption: ReactNode;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row, index: number) => string;
  readonly testId?: string;
  readonly emptyTitle?: string;
  readonly emptyReason?: string;
  /** Printed after the count, e.g. "of 652 on the roster". */
  readonly countSuffix?: string;
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  testId,
  emptyTitle = 'Nothing to show',
  emptyReason = 'No row matched the current filters.',
  countSuffix,
}: DataTableProps<Row>) {
  if (rows.length === 0) {
    return (
      <div data-testid={testId}>
        <EmptyState title={emptyTitle} reason={emptyReason} />
      </div>
    );
  }

  return (
    <div className="table-wrap" data-testid={testId}>
      <table className="data">
        <caption>
          {caption} <span className="muted">- {rows.length} row{rows.length === 1 ? '' : 's'}
          {countSuffix ? ` ${countSuffix}` : ''}</span>
        </caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined}>
                {c.sortHref ? <a href={c.sortHref}>{c.head}</a> : c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? 'num' : undefined}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default DataTable;
