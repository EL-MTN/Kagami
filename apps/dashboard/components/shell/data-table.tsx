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
  children: ReactNode;
  empty?: ReactNode;
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
              <TableHead key={col.key} className={col.className}>
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {showEmpty ? (
            <TableRow className="hover:bg-transparent">
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

export function DataRow({ children }: { children: ReactNode }) {
  return <TableRow>{children}</TableRow>;
}
