import { hostname } from "node:os";
import pino from "pino";
import pretty from "pino-pretty";
import type { LoggerOptions } from "pino";
import { createKansokuStream } from "./kansoku-stream.js";
import type { KansokuStreamOptions } from "./kansoku-stream.js";
import { getTraceContext } from "./trace.js";

export interface ServiceBindings {
  service: string;
  component: string;
  env: string;
}

export interface LoggerBaseBindings extends ServiceBindings {
  pid: number;
  hostname: string;
}

// Snapshot pid + hostname eagerly at call time so loggers built at module load
// don't drift if a later refactor wraps them in a deferred factory.
export function buildLoggerBase(bindings: ServiceBindings): LoggerBaseBindings {
  return {
    pid: process.pid,
    hostname: hostname(),
    ...bindings,
  };
}

const PINO_LEVELS = new Set<string>(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

export interface CreateLoggerOptions extends ServiceBindings {
  level?: string;
  formatters?: LoggerOptions["formatters"];
  /**
   * When provided, every log line is fanned out (alongside stdout) to the
   * Kansoku observability service via a batched HTTP shipper. The shipper is
   * fail-open: network errors are swallowed and retried with backoff; nothing
   * here can block or throw into the caller.
   */
  kansoku?: KansokuStreamOptions;
}

export function createLogger(opts: CreateLoggerOptions): pino.Logger {
  const { service, component, env, level = "info", formatters, kansoku } = opts;

  // Validate `level` against pino's known vocabulary before any pino object
  // is created. A typo like "INFO" or "verbose" used to slip through
  // pino's level resolution and silently route nothing (or everything) to
  // one of the streams; now it fails fast with a clear message.
  if (!PINO_LEVELS.has(level)) {
    throw new Error(
      `createLogger: invalid level "${level}". Allowed: ${[...PINO_LEVELS].join(", ")}`,
    );
  }

  const pinoOptions: LoggerOptions = {
    level,
    base: buildLoggerBase({ service, component, env }),
    // The workspace-wide error convention is `logger.<level>({ error }, msg)`.
    // `errorKey` routes a bare Error first-arg to the same `error` key, and
    // pino's standard error serializer expands it into { type, message, stack }
    // so failures keep their stack on the wire.
    errorKey: "error",
    serializers: { error: pino.stdSerializers.err },
    // Mixin runs on every log call and merges its return value into the
    // emitted record. Reading from AsyncLocalStorage means every log line
    // inside a traced request auto-includes traceId/spanId without callers
    // having to thread context manually. The return value is the target of
    // pino's default `Object.assign(mixinObject, mergeObject)` strategy, so
    // we MUST return a fresh extensible object every call — a shared/frozen
    // sentinel would throw on any `logger.info({...}, "msg")` outside a
    // trace context.
    mixin: () => {
      const ctx = getTraceContext();
      if (!ctx) return {};
      return ctx.parentSpanId
        ? { traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId }
        : { traceId: ctx.traceId, spanId: ctx.spanId };
    },
    ...(formatters ? { formatters } : {}),
  };

  // Console rendering: pretty in dev, raw JSON in production. Run as in-process
  // streams (not pino worker-thread transports) so multistream can compose them
  // with the Kansoku shipper without bridging worker boundaries.
  const consoleStream: NodeJS.WritableStream =
    env !== "production"
      ? pretty({ colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" })
      : process.stdout;

  if (!kansoku) {
    return pino(pinoOptions, consoleStream);
  }

  const kansokuStream = createKansokuStream(kansoku);
  // `level` is already validated against PINO_LEVELS above; the cast is
  // safe — pino's StreamEntry just wants its narrow `Level` union.
  const streamLevel = level as pino.Level;
  const streams: pino.StreamEntry[] = [
    { level: streamLevel, stream: consoleStream },
    { level: streamLevel, stream: kansokuStream },
  ];
  return pino(pinoOptions, pino.multistream(streams));
}

export type { Logger } from "pino";
export type { KansokuStreamOptions } from "./kansoku-stream.js";
export type { TraceContext } from "./trace.js";
export {
  childSpan,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  getTraceContext,
  newTraceContext,
  parseTraceparent,
  runWithTrace,
  withRootTrace,
} from "./trace.js";
