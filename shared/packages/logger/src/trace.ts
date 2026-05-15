import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * W3C trace context (https://www.w3.org/TR/trace-context/) carried through
 * the workspace. `traceId` is 32 hex chars; `spanId` is 16 hex. `sampled`
 * follows the W3C flags bit but we always sample at Kagami's personal scale.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

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

/** Brand new trace — fresh trace + span IDs, no parent. */
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
