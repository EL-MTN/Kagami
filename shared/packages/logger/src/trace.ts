import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * W3C trace context (https://www.w3.org/TR/trace-context/) carried through
 * the workspace. `traceId` is 32 hex chars; `spanId` is 16 hex. `sampled`
 * follows the W3C flags bit: on a fresh root it's a head decision driven by
 * `LOG_SAMPLE_RATE` (default 1 = keep everything); an explicit
 * `newTraceContext({ sampled })` still overrides, and `childSpan` /
 * `parseTraceparent` inherit the upstream bit so the decision is made once
 * at the trace root and respected everywhere downstream.
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
 * Head sampling rate from `LOG_SAMPLE_RATE`, clamped to [0,1]. Unset, empty,
 * or unparseable → 1 (fail-open: never silently drop because of a typo'd
 * rate). Read per root-trace creation, not per log line — `newTraceContext`
 * fires once per request / scheduler tick, so the env read is negligible and
 * stays test-friendly (set the env, no module reload needed). trace.ts must
 * not import the logger (cycle), so a bad value clamps silently.
 */
function resolveSampleRate(): number {
  const raw = process.env.LOG_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

function headSampleDecision(): boolean {
  const rate = resolveSampleRate();
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

/**
 * Brand new trace — fresh trace + span IDs, no parent. `sampled` defaults to
 * the `LOG_SAMPLE_RATE` head decision; pass `{ sampled }` to force it (e.g.
 * always-sample a critical job).
 */
export function newTraceContext(opts: { sampled?: boolean } = {}): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    sampled: opts.sampled ?? headSampleDecision(),
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
