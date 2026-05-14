import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/shell";
import { LevelBadge } from "@/components/level-badge";
import { getTrace, type StoredLog } from "@/lib/api";
import { formatDateTime, formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

interface Span {
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  endMs: number;
  service: string;
  component: string;
  logs: StoredLog[];
  worstLevel: string;
  children: Span[];
}

const LEVEL_RANK: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function buildSpans(logs: StoredLog[]): Span[] {
  const bySpanId = new Map<string, Span>();
  // We need spanId to group; fall back to a synthetic id for spanless logs so
  // they still render under the trace (typically there should always be one).
  for (const log of logs) {
    const spanId = log.spanId ?? `__none__`;
    let span = bySpanId.get(spanId);
    if (!span) {
      span = {
        spanId,
        parentSpanId: log.parentSpanId,
        startMs: new Date(log.ts).getTime(),
        endMs: new Date(log.ts).getTime(),
        service: log.meta.service,
        component: log.meta.component,
        logs: [],
        worstLevel: log.meta.level,
        children: [],
      };
      bySpanId.set(spanId, span);
    }
    const t = new Date(log.ts).getTime();
    if (t < span.startMs) span.startMs = t;
    if (t > span.endMs) span.endMs = t;
    if ((LEVEL_RANK[log.meta.level] ?? 0) > (LEVEL_RANK[span.worstLevel] ?? 0)) {
      span.worstLevel = log.meta.level;
    }
    if (log.parentSpanId && !span.parentSpanId) span.parentSpanId = log.parentSpanId;
    span.logs.push(log);
  }

  // Wire parent → child. Spans whose parentSpanId isn't in the set are roots.
  const roots: Span[] = [];
  for (const span of bySpanId.values()) {
    if (span.parentSpanId && bySpanId.has(span.parentSpanId)) {
      bySpanId.get(span.parentSpanId)!.children.push(span);
    } else {
      roots.push(span);
    }
  }
  // Stable order: start time ascending.
  const byStart = (a: Span, b: Span) => a.startMs - b.startMs;
  roots.sort(byStart);
  for (const s of bySpanId.values()) s.children.sort(byStart);
  return roots;
}

function flatten(roots: Span[]): { span: Span; depth: number }[] {
  const out: { span: Span; depth: number }[] = [];
  const walk = (s: Span, depth: number): void => {
    out.push({ span: s, depth });
    for (const c of s.children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

interface TracePageProps {
  params: Promise<{ id: string }>;
}

export default async function TracePage({ params }: TracePageProps) {
  const { id } = await params;
  if (!TRACE_ID_RE.test(id)) notFound();

  let logs: StoredLog[] = [];
  let error: string | undefined;
  try {
    const res = await getTrace(id);
    logs = res.logs;
  } catch (err) {
    error = (err as Error).message;
  }

  if (error) {
    return (
      <div className="space-y-8">
        <PageHeader title="Trace" description={`ID ${id}`} />
        <div className="rounded-lg border border-[color:var(--color-critical)]/30 bg-[color:var(--color-critical)]/5 p-4 text-[12px] text-[color:var(--color-critical)]">
          {error}
        </div>
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="space-y-8">
        <PageHeader title="Trace" description={`ID ${id}`} />
        <EmptyState>No logs recorded for this trace.</EmptyState>
      </div>
    );
  }

  const roots = buildSpans(logs);
  const flat = flatten(roots);
  const traceStartMs = Math.min(...flat.map((f) => f.span.startMs));
  const traceEndMs = Math.max(...flat.map((f) => f.span.endMs));
  const totalMs = Math.max(traceEndMs - traceStartMs, 1);

  const services = new Set(logs.map((l) => l.meta.service));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Trace"
        description={
          <>
            <span className="font-mono text-xs text-foreground">{id}</span>
            <span className="mx-2 text-faint">·</span>
            {formatDateTime(new Date(traceStartMs))}
          </>
        }
        meta={
          <div className="flex items-center gap-4 text-[11px] tabular-nums text-faint">
            <span>
              {logs.length} log{logs.length === 1 ? "" : "s"}
            </span>
            <span>
              {flat.length} span{flat.length === 1 ? "" : "s"}
            </span>
            <span>
              {services.size} service{services.size === 1 ? "" : "s"}
            </span>
            <span className="font-mono text-foreground">{totalMs.toLocaleString()} ms</span>
          </div>
        }
      />

      <section className="space-y-1">
        <h3 className="kicker mb-3">Waterfall</h3>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {flat.map(({ span, depth }) => {
            const offsetPct = ((span.startMs - traceStartMs) / totalMs) * 100;
            const widthPct = Math.max(((span.endMs - span.startMs) / totalMs) * 100, 0.5);
            const duration = span.endMs - span.startMs;
            return (
              <div
                key={span.spanId}
                className="grid grid-cols-[240px_1fr_70px] items-center gap-3 border-b border-border px-3 py-2 text-[12px] tabular-nums last:border-b-0"
              >
                <div
                  className="flex items-center gap-2 truncate"
                  style={{ paddingLeft: `${depth * 14}px` }}
                >
                  <LevelBadge level={span.worstLevel} />
                  <span className="truncate text-foreground" title={span.service}>
                    {span.service}
                  </span>
                  <span className="text-faint">·</span>
                  <span className="truncate text-muted-foreground">{span.component}</span>
                </div>
                <div className="relative h-5 rounded-sm bg-muted">
                  <div
                    className={cn(
                      "absolute top-0 h-full rounded-sm",
                      span.worstLevel === "error" || span.worstLevel === "fatal"
                        ? "bg-[color:var(--color-critical)]/40"
                        : span.worstLevel === "warn"
                          ? "bg-[color:var(--color-caution)]/40"
                          : "bg-primary/30",
                    )}
                    style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                    title={`${duration} ms`}
                  />
                </div>
                <span className="text-right font-mono text-faint">{duration} ms</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="kicker">Log timeline</h3>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {logs.map((log, i) => (
            <div
              key={`${log.spanId ?? "x"}-${i}`}
              className="grid grid-cols-[100px_70px_140px_120px_1fr] items-baseline gap-3 border-b border-border px-3 py-2 font-mono text-[12px] tabular-nums last:border-b-0"
            >
              <span className="text-faint" title={new Date(log.ts).toISOString()}>
                {formatTimestamp(log.ts)}
              </span>
              <LevelBadge level={log.meta.level} />
              <span className="truncate text-muted-foreground">{log.meta.service}</span>
              <span className="truncate text-faint" title={log.spanId}>
                {log.spanId ? log.spanId.slice(0, 8) : "—"}
              </span>
              <span className="break-words text-foreground">
                {log.msg ?? <span className="text-faint">—</span>}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
