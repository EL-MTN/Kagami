"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RoutineLogItem } from "@/lib/routine-schema";

interface ApiLogResponse {
  logs: RoutineLogItem[];
  hasMore: boolean;
}

interface RoutineLogTableProps {
  routineId: string;
  initialLogs: RoutineLogItem[];
  initialHasMore: boolean;
}

function formatDuration(start: string, end?: string): string {
  if (!end) return "\u2014";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

export function RoutineLogTable({ routineId, initialLogs, initialHasMore }: RoutineLogTableProps) {
  const [logs, setLogs] = useState(initialLogs);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    if (!hasMore || loading) return;

    const lastLog = logs[logs.length - 1];
    if (!lastLog) return;

    setLoading(true);
    try {
      const res = await fetch(
        `/api/routines/${routineId}/logs?limit=50&before=${lastLog.startedAt}`,
      );
      const data = (await res.json()) as ApiLogResponse;
      setLogs((prev) => [...prev, ...data.logs]);
      setHasMore(data.hasMore);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-border hover:bg-transparent">
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Started
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Duration
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Trigger
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Status
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Summary
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow
                key={log.id}
                className="border-border/50 transition-colors hover:bg-primary/[0.02]"
              >
                <TableCell className="text-xs tabular-nums text-muted-foreground">
                  {new Date(log.startedAt).toLocaleString()}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatDuration(log.startedAt, log.completedAt)}
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">{log.trigger}</span>
                </TableCell>
                <TableCell>
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs ${
                      log.status === "completed"
                        ? "text-primary/60"
                        : log.status === "failed"
                          ? "text-destructive-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        log.status === "completed"
                          ? "bg-primary/60"
                          : log.status === "failed"
                            ? "bg-destructive/60"
                            : "bg-muted-foreground/50 animate-pulse"
                      }`}
                    />
                    {log.status}
                  </span>
                </TableCell>
                <TableCell className="max-w-md">
                  {log.summary ? (
                    <details>
                      <summary className="max-w-md cursor-pointer truncate text-xs text-foreground/70">
                        {log.summary.slice(0, 120)}
                        {log.summary.length > 120 ? "..." : ""}
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                        {log.summary}
                      </p>
                    </details>
                  ) : (
                    <span className="text-xs text-faint">&mdash;</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                  No executions yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadMore()}
            disabled={loading}
            className="text-muted-foreground"
          >
            {loading ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
