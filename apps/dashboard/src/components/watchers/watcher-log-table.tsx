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
import type { WatcherLogItem } from "@/lib/watcher-schema";

interface ApiLogResponse {
  logs: WatcherLogItem[];
  hasMore: boolean;
}

interface WatcherLogTableProps {
  watcherId: string;
  initialLogs: WatcherLogItem[];
  initialHasMore: boolean;
}

function formatDuration(start: string, end?: string): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function verdictLabel(log: WatcherLogItem): { label: string; tone: string } {
  if (log.status === "running") return { label: "running", tone: "text-muted-foreground" };
  if (log.status === "failed") return { label: "failed", tone: "text-destructive-foreground" };
  if (log.suppressed) return { label: "silenced", tone: "text-muted-foreground/70" };
  if (log.triggered) return { label: "triggered", tone: "text-primary" };
  return { label: "no change", tone: "text-primary/40" };
}

export function WatcherLogTable({ watcherId, initialLogs, initialHasMore }: WatcherLogTableProps) {
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
        `/api/watchers/${watcherId}/logs?limit=50&before=${lastLog.startedAt}`,
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
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Started
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Duration
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Trigger
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Outcome
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Summary
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => {
              const verdict = verdictLabel(log);
              return (
                <TableRow
                  key={log.id}
                  className="border-border/50 transition-colors hover:bg-primary/[0.02]"
                >
                  <TableCell className="text-xs tabular-nums text-muted-foreground">
                    {new Date(log.startedAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground/60">
                    {formatDuration(log.startedAt, log.completedAt)}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground/60">{log.trigger}</span>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center gap-1.5 text-xs ${verdict.tone}`}>
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          log.status === "running"
                            ? "bg-muted-foreground/50 animate-pulse"
                            : log.status === "failed"
                              ? "bg-destructive/60"
                              : log.suppressed
                                ? "bg-muted-foreground/40"
                                : log.triggered
                                  ? "bg-primary"
                                  : "bg-primary/30"
                        }`}
                      />
                      {verdict.label}
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
                        {log.newState && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-muted-foreground/40">
                              State
                            </summary>
                            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground/70">
                              {log.newState}
                            </p>
                          </details>
                        )}
                      </details>
                    ) : (
                      <span className="text-xs text-muted-foreground/30">&mdash;</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {logs.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-12 text-center text-sm text-muted-foreground/60"
                >
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
