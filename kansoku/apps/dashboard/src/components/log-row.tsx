"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LevelBadge } from "./level-badge";
import type { StoredLog } from "@/lib/api";

interface LogRowProps {
  log: StoredLog;
  showSpanId?: boolean;
}

function renderValue(v: unknown, indent: string): string {
  if (typeof v === "string") {
    const body = v.includes("\n") ? v.split("\n").join(`\n${indent}`) : v;
    return `"${body}"`;
  }
  if (v === null || typeof v !== "object") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const inner = v.map((x) => `${indent}  ${renderValue(x, `${indent}  `)}`).join("\n");
    return `[\n${inner}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const inner = entries
    .map(([k, val]) => `${indent}  ${k}: ${renderValue(val, `${indent}  `)}`)
    .join("\n");
  return `{\n${inner}\n${indent}}`;
}

export function LogRow({ log, showSpanId = false }: LogRowProps) {
  const fields = log.fields;
  const fieldCount = fields ? Object.keys(fields).length : 0;
  const hasFields = fieldCount > 0;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="grid grid-cols-[16px_100px_70px_140px_1fr_72px] items-baseline gap-3 px-3 py-2 font-mono text-[12px] tabular-nums">
        {hasFields ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? "Collapse log fields"
                : `Expand ${fieldCount} log field${fieldCount === 1 ? "" : "s"}`
            }
            className="flex h-4 w-4 items-center justify-center self-center text-faint transition-colors hover:text-foreground"
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
              strokeWidth={2}
            />
          </button>
        ) : (
          <span aria-hidden className="select-none" />
        )}
        <span className="text-faint" title={new Date(log.ts).toISOString()}>
          {formatTimestamp(log.ts)}
        </span>
        <LevelBadge level={log.meta.level} />
        <span
          className="truncate text-muted-foreground"
          title={`${log.meta.service} · ${log.meta.component}`}
        >
          {log.meta.service}
        </span>
        <span className="min-w-0 break-all text-foreground">
          {log.msg ?? <span className="text-faint">—</span>}
          {hasFields && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="ml-2 align-baseline text-[10px] text-faint transition-colors hover:text-primary"
            >
              +{fieldCount} field{fieldCount === 1 ? "" : "s"}
            </button>
          )}
        </span>
        {showSpanId ? (
          <span
            className="justify-self-end text-[10px] text-faint"
            title={log.spanId ? `Span ${log.spanId}` : undefined}
          >
            {log.spanId ? log.spanId.slice(0, 8) : "—"}
          </span>
        ) : log.traceId ? (
          <Link
            href={`/traces/${log.traceId}`}
            className="justify-self-end text-[10px] text-muted-foreground transition-colors hover:text-primary"
            title={`Trace ${log.traceId}`}
          >
            {log.traceId.slice(0, 8)}
          </Link>
        ) : (
          <span className="justify-self-end text-[10px] text-faint">—</span>
        )}
      </div>
      {hasFields && expanded && (
        <pre className="overflow-x-auto border-t border-border bg-muted/30 px-3 py-2 pl-[31px] font-mono text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
          {renderValue(fields, "")}
        </pre>
      )}
    </div>
  );
}
