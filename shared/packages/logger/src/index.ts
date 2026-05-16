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

// Emit `"level":"info"` instead of pino's numeric `30`. Off-the-shelf log
// tooling (Datadog/Loki/ELK/OTel) keys severity off a string label; the
// numeric form needs a per-vendor decoder ring. Kansoku ingest accepts both
// the string and legacy-numeric forms during the rollout window, so this is
// safe to flip ahead of every producer restarting.
const stringLevelFormatter = (label: string): { level: string } => ({ level: label });

// Console rendering decision, decoupled from `env`. `env !== "production"`
// silently broke stdout collectors on any deployed box with an unset
// NODE_ENV (or a staging env), which emitted human-pretty text where a JSON
// collector expected NDJSON. Now: pretty only when explicitly asked
// (`LOG_PRETTY=1`) or when stdout is an interactive TTY; JSON everywhere
// else (pipes, files, collectors, systemd, containers).
function shouldPretty(): boolean {
  const flag = process.env.LOG_PRETTY?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return Boolean(process.stdout.isTTY);
}

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
    // ISO-8601 timestamps (`"time":"2026-05-15T…Z"`) instead of epoch-ms.
    // Same portability rationale as the string level: collectors and trace
    // backends parse RFC3339 natively; epoch-ms needs a transform step.
    // Kansoku ingest accepts both forms during rollout.
    timestamp: pino.stdTimeFunctions.isoTime,
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
    // Default to the string-level formatter; let an explicit caller
    // `formatters.level` (or `.bindings`/`.log`) win. Spreading `formatters`
    // last means a caller can override the level shape but doesn't lose it
    // by passing only `bindings`/`log`.
    formatters: { level: stringLevelFormatter, ...formatters },
  };

  // Console rendering: human-pretty on a TTY (or `LOG_PRETTY=1`), raw NDJSON
  // everywhere else — see `shouldPretty`. Run as in-process streams (not pino
  // worker-thread transports) so multistream can compose them with the
  // Kansoku shipper without bridging worker boundaries.
  const consoleStream: NodeJS.WritableStream = shouldPretty()
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
