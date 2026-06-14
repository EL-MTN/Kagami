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

// Low-signal infra fields that shouldn't lead the expanded view; rendered
// last and dimmed so the meaningful fields read first (not dropped).
const INFRA_KEYS = new Set(["pid", "hostname"]);

// Keys most likely to carry the human-readable gist of a log, in priority
// order. The collapsed-row inline preview shows the first one present.
const PREVIEW_KEYS = ["responsePreview", "query", "text", "preview", "msg", "message"];

// Pick the single most useful scalar field to preview next to "+N fields".
// Prefer the curated keys above; otherwise fall back to the first scalar that
// isn't infra noise. Returns the value as a trimmed, length-capped string.
function pickPreview(fields: Record<string, unknown>): string | null {
  const scalar = (v: unknown): v is string | number =>
    typeof v === "string" || typeof v === "number";

  for (const key of PREVIEW_KEYS) {
    const v = fields[key];
    if (scalar(v)) {
      const s = String(v).trim();
      if (s) return truncate(s);
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (INFRA_KEYS.has(k) || !scalar(v)) continue;
    const s = String(v).trim();
    if (s) return truncate(s);
  }
  return null;
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function LogRow({ log, showSpanId = false }: LogRowProps) {
  const fields = log.fields;
  const fieldCount = fields ? Object.keys(fields).length : 0;
  const hasFields = fieldCount > 0;
  const [expanded, setExpanded] = useState(false);

  // Split meaningful fields from low-signal infra (pid/hostname) so the
  // expanded view leads with what matters; infra is rendered last and dimmed.
  const fieldEntries = fields ? Object.entries(fields) : [];
  const mainEntries = fieldEntries.filter(([k]) => !INFRA_KEYS.has(k));
  const infraEntries = fieldEntries.filter(([k]) => INFRA_KEYS.has(k));
  const preview = !expanded && fields ? pickPreview(fields) : null;

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
          {preview && (
            <span className="ml-2 align-baseline text-[11px] text-faint" title={preview}>
              {preview}
            </span>
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
            className="-my-2 flex items-center justify-end self-stretch py-2 text-[10px] text-muted-foreground underline decoration-transparent decoration-dotted underline-offset-2 transition-colors hover:text-primary hover:decoration-current"
            title={`View trace ${log.traceId}`}
          >
            {log.traceId.slice(0, 8)}
          </Link>
        ) : (
          <span className="justify-self-end text-[10px] text-faint">—</span>
        )}
      </div>
      {hasFields && expanded && (
        <div className="overflow-x-auto border-t border-border bg-muted/30 px-3 py-2 pl-[31px] font-mono text-[11px]">
          {mainEntries.length > 0 && (
            <pre className="whitespace-pre-wrap break-words text-muted-foreground">
              {renderValue(Object.fromEntries(mainEntries), "")}
            </pre>
          )}
          {infraEntries.map(([k, v]) => (
            <pre key={k} className="whitespace-pre-wrap break-words text-faint">
              {`${k}: ${renderValue(v, "")}`}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}
