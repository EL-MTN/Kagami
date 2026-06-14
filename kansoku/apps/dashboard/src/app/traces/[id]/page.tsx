import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/shell";
import { LevelBadge } from "@/components/level-badge";
import { LogRow } from "@/components/log-row";
import { getTrace, type StoredLog, type StoredSpan } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

interface Span {
  spanId: string;
  parentSpanId?: string;
  name?: string;
  // @kagami/llm call-op label (e.g. "answer", "extract") — only on real spans
  // that wrap a generate call. Disambiguates the otherwise-identical
  // "llm.generate" name across the six per-message inference calls.
  op?: string;
  startMs: number;
  endMs: number;
  service: string;
  component: string;
  logs: StoredLog[];
  worstLevel: string;
  children: Span[];
}

// Component values that carry no signal once we already show the service and a
// concrete op — drop them from the faint sub-label so it doesn't read
// "kioku-api · llm · answer" when "answer" already says everything.
const NOISE_COMPONENTS = new Set(["llm", "inference", "provider", "default", ""]);

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
    if (log.parentSpanId && !span.parentSpanId) {
      span.parentSpanId = log.parentSpanId;
    } else if (log.parentSpanId && span.parentSpanId && log.parentSpanId !== span.parentSpanId) {
      // Two logs claim the same spanId but disagree on parent. Almost always
      // a producer bug (forgot to re-bind context, log emitted during an
      // unrelated async transition). First-write-wins is preserved; surface
      // the disagreement on the Next.js *server* console (this is a server
      // component) so the operator running `npm run kansoku:dev:dashboard`
      // sees it without scraping logs.
      console.warn(
        `[trace ${spanId}] parentSpanId disagreement: kept ${span.parentSpanId}, saw ${log.parentSpanId}`,
      );
    }
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

// Real spans (build-light tracing): accurate durations + an explicit
// parent/child tree, so no timestamp guessing. Same `Span` shape as the
// log-derived path so the waterfall renderer is shared.
function buildSpansFromStored(spans: StoredSpan[]): Span[] {
  const byId = new Map<string, Span>();
  for (const s of spans) {
    const startMs = new Date(s.startedAt).getTime();
    byId.set(s.spanId, {
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      name: s.name,
      op: s.op,
      startMs,
      endMs: startMs + s.durationMs,
      service: s.service,
      component: s.component,
      logs: [],
      worstLevel: s.status === "error" ? "error" : "info",
      children: [],
    });
  }
  const roots: Span[] = [];
  for (const span of byId.values()) {
    if (span.parentSpanId && byId.has(span.parentSpanId)) {
      byId.get(span.parentSpanId)!.children.push(span);
    } else {
      roots.push(span);
    }
  }
  const byStart = (a: Span, b: Span) => a.startMs - b.startMs;
  roots.sort(byStart);
  for (const s of byId.values()) s.children.sort(byStart);
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

// Evenly-spaced tick marks across the [0, totalMs] bar track for the time
// axis. Returns {ms, pct} so the renderer can drop a faint gridline + label at
// each. Five steps (0%, 25%, 50%, 75%, 100%) reads cleanly without crowding.
function axisTicks(totalMs: number): { ms: number; pct: number }[] {
  const STEPS = 4;
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const pct = (i / STEPS) * 100;
    return { ms: Math.round((totalMs * i) / STEPS), pct };
  });
}

// Primary label for a span row. Prefer the call-op (so the six identical
// "llm.generate" spans become "answer", "extract", …); otherwise the span
// name; otherwise the component. When both name and op exist and differ, lead
// with the op — "answer · llm.generate" — so the disambiguating op stays
// visible even when the headline truncates (leading with the shared name would
// truncate every row to an identical "llm.generate · …").
function spanHeadline(span: Span): string {
  if (span.op && span.name && span.op !== span.name) return `${span.op} · ${span.name}`;
  return span.op ?? span.name ?? span.component;
}

// Faint "service · component" sub-label. The component segment is dropped when
// an op already carries the signal and the component is a noise token, so the
// sub-label stays a clean origin tag rather than echoing the headline.
function spanSubLabel(span: Span): string {
  const dropComponent = Boolean(span.op) && NOISE_COMPONENTS.has(span.component.toLowerCase());
  return dropComponent || !span.component ? span.service : `${span.service} · ${span.component}`;
}

interface TracePageProps {
  params: Promise<{ id: string }>;
}

export default async function TracePage({ params }: TracePageProps) {
  const { id } = await params;
  if (!TRACE_ID_RE.test(id)) notFound();

  let logs: StoredLog[] = [];
  let spans: StoredSpan[] = [];
  let error: string | undefined;
  try {
    const res = await getTrace(id);
    logs = res.logs;
    spans = res.spans ?? [];
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

  if (logs.length === 0 && spans.length === 0) {
    return (
      <div className="space-y-8">
        <PageHeader title="Trace" description={`ID ${id}`} />
        <EmptyState>No logs recorded for this trace.</EmptyState>
      </div>
    );
  }

  // Prefer real spans (accurate durations + explicit tree); fall back to the
  // log-timestamp-derived approximation for traces predating build-light
  // spans.
  const useRealSpans = spans.length > 0;
  const roots = useRealSpans ? buildSpansFromStored(spans) : buildSpans(logs);
  const flatAll = flatten(roots);
  // Use `reduce` instead of `Math.min(...flat.map())` — spread args have a
  // V8-imposed cap (~65k) that we shouldn't approach, but the safer
  // formulation costs nothing.
  const traceStartMs = flatAll.reduce(
    (acc, f) => (f.span.startMs < acc ? f.span.startMs : acc),
    Number.POSITIVE_INFINITY,
  );
  const traceEndMs = flatAll.reduce(
    (acc, f) => (f.span.endMs > acc ? f.span.endMs : acc),
    Number.NEGATIVE_INFINITY,
  );
  const totalMs = Math.max(traceEndMs - traceStartMs, 1);
  const ticks = axisTicks(totalMs);

  // Cap rendered rows so a pathological trace can't jank the page. The
  // remainder is summarized in a footer; users can drill into the time
  // range with /search if needed.
  const WATERFALL_RENDER_CAP = 500;
  const LOG_TIMELINE_RENDER_CAP = 2000;
  // Pull "ungrouped" synthetic-id spans out of the waterfall — they don't
  // represent real spans, they're a holding bin for logs that lacked a
  // spanId. Render them as a separate "Untraced logs" section below.
  const untracedFlat = flatAll.filter((f) => f.span.spanId === "__none__");
  const realFlat = flatAll.filter((f) => f.span.spanId !== "__none__");
  const flatWaterfall = realFlat.slice(0, WATERFALL_RENDER_CAP);
  const flatHidden = realFlat.length - flatWaterfall.length;
  const logsToRender = logs.slice(0, LOG_TIMELINE_RENDER_CAP);
  const logsHidden = logs.length - logsToRender.length;

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
              {flatAll.length} span{flatAll.length === 1 ? "" : "s"}
            </span>
            <span>
              {services.size} service{services.size === 1 ? "" : "s"}
            </span>
            <span className="font-mono text-foreground">{totalMs.toLocaleString()} ms</span>
          </div>
        }
      />

      <section className="space-y-1">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="kicker">Waterfall</h3>
          <span className="text-[10px] uppercase tracking-wide text-faint">
            {useRealSpans ? "real spans" : "log-derived (approx.)"}
          </span>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {/* Time axis: a baseline scale over the bar track so each span's
              horizontal offset reads as a real elapsed-time position rather
              than an arbitrary indent. Aligned to the same three-column grid
              as every row so ticks sit exactly under the bars. */}
          <div className="grid grid-cols-[minmax(260px,36%)_1fr_72px] items-end gap-3 border-b border-border bg-muted/20 px-3 pb-1 pt-2">
            <span className="kicker self-end">Span</span>
            <div className="relative h-4">
              {ticks.map((t, i) => (
                <span
                  key={t.pct}
                  className={cn(
                    "absolute bottom-0 whitespace-nowrap font-mono text-[9px] tabular-nums text-faint",
                    i === 0 ? "left-0" : i === ticks.length - 1 ? "right-0" : "-translate-x-1/2",
                  )}
                  style={i === 0 || i === ticks.length - 1 ? undefined : { left: `${t.pct}%` }}
                >
                  {t.ms.toLocaleString()}
                </span>
              ))}
            </div>
            <span className="text-right text-[9px] uppercase tracking-wide text-faint">ms</span>
          </div>
          {flatWaterfall.map(({ span, depth }) => {
            const offsetPct = ((span.startMs - traceStartMs) / totalMs) * 100;
            const widthPct = Math.max(((span.endMs - span.startMs) / totalMs) * 100, 0.5);
            const duration = span.endMs - span.startMs;
            const headline = spanHeadline(span);
            const subLabel = spanSubLabel(span);
            return (
              <div
                key={span.spanId}
                className="grid grid-cols-[minmax(260px,36%)_1fr_72px] items-center gap-3 border-b border-border px-3 py-2 text-[12px] tabular-nums last:border-b-0"
              >
                <div
                  className="flex min-w-0 items-start gap-2"
                  style={{ paddingLeft: `${depth * 14}px` }}
                >
                  <LevelBadge level={span.worstLevel} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 leading-tight">
                    <div
                      className="truncate font-mono text-[12px] text-foreground"
                      title={headline}
                    >
                      {headline}
                    </div>
                    <div className="truncate text-[10px] text-faint" title={subLabel}>
                      {subLabel}
                    </div>
                  </div>
                </div>
                <div className="relative h-5 rounded-sm bg-muted">
                  {/* Gridlines aligned with the axis ticks above — faint hairlines
                      so a bar's start/end can be eyeballed against the scale. */}
                  {ticks.map((t) => (
                    <span
                      key={t.pct}
                      aria-hidden
                      className="absolute top-0 bottom-0 w-px bg-border/60"
                      style={{ left: `${t.pct}%` }}
                    />
                  ))}
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
          {flatHidden > 0 && (
            <div className="border-t border-border bg-muted/30 px-3 py-2 text-center text-[11px] tabular-nums text-faint">
              + {flatHidden.toLocaleString()} more span{flatHidden === 1 ? "" : "s"} not shown · use
              /search to inspect a narrower time range
            </div>
          )}
        </div>
      </section>

      {untracedFlat.length > 0 && (
        <section className="space-y-1">
          <h3 className="kicker mb-3">Untraced logs in this trace</h3>
          <p className="text-[11px] text-faint">
            {untracedFlat.reduce((n, f) => n + f.span.logs.length, 0)} log
            {untracedFlat.reduce((n, f) => n + f.span.logs.length, 0) === 1 ? "" : "s"} in this
            trace were emitted without a spanId. They still appear in the log timeline below —
            listed here so they're not lost in the waterfall.
          </p>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="kicker">Log timeline</h3>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {logsToRender.map((log, i) => (
            <LogRow key={`${log.ts}-${log.spanId ?? "none"}-${i}`} log={log} showSpanId />
          ))}
          {logsHidden > 0 && (
            <div className="border-t border-border bg-muted/30 px-3 py-2 text-center text-[11px] tabular-nums text-faint">
              + {logsHidden.toLocaleString()} more log line
              {logsHidden === 1 ? "" : "s"} not shown
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
