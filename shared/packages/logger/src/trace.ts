import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

/**
 * W3C trace context (https://www.w3.org/TR/trace-context/) carried through
 * the workspace. `traceId` is 32 hex chars; `spanId` is 16 hex. `sampled`
 * follows the W3C flags bit and defaults to true on fresh contexts — every
 * log ships in full (this is a single-user system; no sampling). The
 * `sampled: false` path is still wired (`newTraceContext({ sampled: false })`,
 * `childSpan`/`parseTraceparent` inheritance) for W3C correctness if an
 * upstream caller ever sends `traceparent` with the bit clear, but no
 * producer in Kagami sets it.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

// W3C §3.2.2.1 restricts producers to lowercase hex on the wire, but the
// spec also tells receivers to be lenient. We accept uppercase (`/i`) and
// normalize to lowercase via `.toLowerCase()` post-parse — keeping
// interoperability with non-spec-strict producers without weakening our
// own emit path (`formatTraceparent` always writes lowercase).
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

const storage = new AsyncLocalStorage<TraceContext>();

export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** Parse a `traceparent` header. Returns undefined on any malformed input. */
export function parseTraceparent(header: string | undefined | null): TraceContext | undefined {
  if (!header) return undefined;
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return undefined;
  // Destructure so the values are typed `string` under `noUncheckedIndexedAccess`.
  // The regex has three required capture groups; the guard is defensive only.
  const [, traceIdRaw, spanIdRaw, flagsRaw] = m;
  if (!traceIdRaw || !spanIdRaw || !flagsRaw) return undefined;
  const traceId = traceIdRaw.toLowerCase();
  const spanId = spanIdRaw.toLowerCase();
  // W3C: all-zero IDs are invalid.
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return {
    traceId,
    spanId,
    sampled: (parseInt(flagsRaw, 16) & 1) === 1,
  };
}

/** Serialize a context as a W3C `traceparent` header value. */
export function formatTraceparent(ctx: TraceContext): string {
  const flags = ctx.sampled ? "01" : "00";
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Brand new trace — fresh trace + span IDs, no parent. `sampled` defaults to
 * true (ship everything); pass `{ sampled: false }` only if you ever need to
 * honor an upstream "don't sample" signal.
 */
export function newTraceContext(opts: { sampled?: boolean } = {}): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    sampled: opts.sampled ?? true,
  };
}

/**
 * Open a child span on the same trace. Used by middleware on the receive side
 * — the incoming context's spanId becomes the child's parent.
 */
export function childSpan(ctx: TraceContext): TraceContext {
  return {
    traceId: ctx.traceId,
    spanId: generateSpanId(),
    parentSpanId: ctx.spanId,
    sampled: ctx.sampled,
  };
}

/**
 * Wrap a callback so each invocation runs inside its own fresh root trace.
 * Useful for scheduler ticks / interval callbacks / cron jobs — anywhere a
 * logically independent unit of work fires without an incoming `traceparent`
 * to inherit from. Returns a void-returning function (the inner result is
 * fire-and-forget) suitable for `setInterval` / `setTimeout`.
 */
export function withRootTrace<Args extends unknown[]>(
  fn: (...args: Args) => unknown,
): (...args: Args) => void {
  return (...args: Args) => {
    void runWithTrace(newTraceContext(), () => fn(...args));
  };
}

// --- Build-light spans -----------------------------------------------------
//
// A span is just timed work on a trace. `runWithSpan` opens a child span,
// times it, and emits ONE span-end event through a sink. `@kagami/logger`
// wires the sink to log an ECS line (`event.kind:"span"`), so spans show in
// tail/search like any log AND get folded into Kansoku's `spans` collection
// for a real waterfall — no separate SDK/exporter (the "build" fork).

export interface SpanEndEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: Date;
  durationMs: number;
  status: "ok" | "error";
}

type SpanSink = (e: SpanEndEvent) => void;
let spanSink: SpanSink | null = null;

/**
 * Register the span-end sink. `createLogger` wires this to emit one span
 * event per completed span. Left unset (a lib used without the factory)
 * `runWithSpan` still runs the work + context — it just doesn't emit.
 */
export function setSpanSink(sink: SpanSink | null): void {
  spanSink = sink;
}

/**
 * Run `fn` inside a fresh child span of the active trace (or a new root if
 * none), measuring wall-clock duration and emitting one span-end event.
 * Re-throws so control flow is unchanged; a thrown span is still recorded
 * with status `"error"`.
 */
export async function runWithSpan<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const parent = getTraceContext();
  const ctx: TraceContext = parent ? childSpan(parent) : newTraceContext();
  const startedAt = new Date();
  const start = performance.now();
  let status: "ok" | "error" = "ok";
  try {
    return await runWithTrace(ctx, fn);
  } catch (err) {
    status = "error";
    throw err;
  } finally {
    const sink = spanSink;
    if (sink) {
      const event: SpanEndEvent = {
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        name,
        startedAt,
        durationMs: Math.round(performance.now() - start),
        status,
      };
      if (ctx.parentSpanId) event.parentSpanId = ctx.parentSpanId;
      sink(event);
    }
  }
}
