import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from "@/components/ui/table";

export interface DataTableColumn {
  key: string;
  label: string;
  /** Tailwind width / class for the <th>. */
  className?: string;
}

interface DataTableProps {
  columns: DataTableColumn[];
  /** Rendered <tr> rows — caller is responsible for hover/border styling. */
  children: ReactNode;
  /** Shown when there are no rows; rendered as a spanning empty row. */
  empty?: ReactNode;
  /**
   * Number of rendered rows. Required to surface the empty state — without
   * it, the empty cell never displays even when `children` is empty (we can't
   * inspect the children count without re-rendering them).
   */
  rowCount: number;
}

export function DataTable({ columns, children, empty, rowCount }: DataTableProps) {
  const showEmpty = rowCount === 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-border hover:bg-transparent">
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={`text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground ${col.className ?? ""}`}
              >
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {showEmpty ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="py-12 text-center text-sm text-faint">
                {empty ?? "Nothing to show."}
              </TableCell>
            </TableRow>
          ) : (
            children
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Standardized <tr> styling so callers don't restate the hover/border classes
 * in every page.
 */
export function DataRow({ children }: { children: ReactNode }) {
  return (
    <TableRow className="border-border transition-colors hover:bg-accent">{children}</TableRow>
  );
}
