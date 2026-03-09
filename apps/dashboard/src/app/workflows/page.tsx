import Link from "next/link";
import cronstrue from "cronstrue";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getWorkflowList } from "@/lib/queries/workflows";

function statusVariant(status: string) {
  switch (status) {
    case "completed":
      return "default" as const;
    case "failed":
      return "destructive" as const;
    case "running":
      return "secondary" as const;
    default:
      return "secondary" as const;
  }
}

export default async function WorkflowsPage() {
  const items = await getWorkflowList();

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Workflows</h2>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Report Mode</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Run</TableHead>
              <TableHead>Next Run</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((w) => (
              <TableRow key={w.id}>
                <TableCell>
                  <Link
                    href={`/workflows/${w.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {w.name}
                  </Link>
                </TableCell>
                <TableCell className="text-sm" title={w.cronSchedule}>
                  {cronstrue.toString(w.cronSchedule, {
                    use24HourTimeFormat: false,
                    verbose: true,
                  })}
                </TableCell>
                <TableCell>
                  <Badge variant={w.reportMode === "alert" ? "secondary" : "default"}>
                    {w.reportMode}
                  </Badge>
                </TableCell>
                <TableCell>
                  {w.enabled ? (
                    <Badge variant="default">enabled</Badge>
                  ) : (
                    <Badge variant="secondary">disabled</Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {w.lastRun ? (
                    <Badge variant={statusVariant(w.lastRun.status)}>{w.lastRun.status}</Badge>
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {w.enabled ? (
                    new Date(w.nextRunAt).toLocaleString()
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(w.createdAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No workflows found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
