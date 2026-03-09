import { notFound } from "next/navigation";
import Link from "next/link";
import cronstrue from "cronstrue";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getWorkflowHistory } from "@/lib/queries/workflows";

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

function formatDuration(start: Date, end?: Date): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

export default async function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workflow, logs } = await getWorkflowHistory(id);

  if (!workflow) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link href="/workflows">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h2 className="text-2xl font-bold">{workflow.name}</h2>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="text-base">{workflow.name}</CardTitle>
            <Badge variant={workflow.enabled ? "default" : "secondary"}>
              {workflow.enabled ? "enabled" : "disabled"}
            </Badge>
            <Badge variant={workflow.reportMode === "alert" ? "secondary" : "default"}>
              {workflow.reportMode}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="rounded bg-muted p-3 text-sm">{workflow.prompt}</div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              <span>
                Schedule:{" "}
                {cronstrue.toString(workflow.cronSchedule, {
                  use24HourTimeFormat: false,
                  verbose: true,
                })}
              </span>
              <span>Next run: {new Date(workflow.nextRunAt).toLocaleString()}</span>
              <span>Chat: {workflow.chatId}</span>
              <span>Created: {new Date(workflow.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <h3 className="text-lg font-semibold">Execution History</h3>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="text-sm">
                  {new Date(log.startedAt).toLocaleString()}
                </TableCell>
                <TableCell className="text-sm font-mono">
                  {formatDuration(log.startedAt, log.completedAt)}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(log.status)}>{log.status}</Badge>
                </TableCell>
                <TableCell className="max-w-md">
                  {log.summary ? (
                    <details>
                      <summary className="cursor-pointer text-sm truncate max-w-md">
                        {log.summary.slice(0, 120)}
                        {log.summary.length > 120 ? "..." : ""}
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                        {log.summary}
                      </p>
                    </details>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  No executions yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
