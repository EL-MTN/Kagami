"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SkillLogItem } from "@/lib/skill-schema";

interface ApiLogResponse {
  logs: SkillLogItem[];
  hasMore: boolean;
}

interface SkillLogTableProps {
  skillId: string;
  initialLogs: SkillLogItem[];
  initialHasMore: boolean;
}

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

function triggerVariant(trigger: string) {
  switch (trigger) {
    case "cron":
      return "outline" as const;
    case "manual":
      return "secondary" as const;
    case "skill":
      return "ghost" as const;
    default:
      return "secondary" as const;
  }
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

export function SkillLogTable({ skillId, initialLogs, initialHasMore }: SkillLogTableProps) {
  const [logs, setLogs] = useState(initialLogs);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    if (!hasMore || loading) return;
    setLoading(true);

    const lastLog = logs[logs.length - 1];
    if (!lastLog) return;

    try {
      const res = await fetch(`/api/skills/${skillId}/logs?limit=50&before=${lastLog.startedAt}`);
      const data = (await res.json()) as ApiLogResponse;
      setLogs((prev) => [...prev, ...data.logs]);
      setHasMore(data.hasMore);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Trigger</TableHead>
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
                  <Badge variant={triggerVariant(log.trigger)}>{log.trigger}</Badge>
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
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No executions yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
