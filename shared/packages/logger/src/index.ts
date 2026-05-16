import { hostname } from "node:os";
import pino from "pino";
import pretty from "pino-pretty";
import type { LoggerOptions } from "pino";
import { createKansokuStream } from "./kansoku-stream.js";
import type { KansokuStreamOptions } from "./kansoku-stream.js";
import { getTraceContext, setSpanSink } from "./trace.js";

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

// Field names follow ECS / OTel resource semantic conventions so logs drop
// straight into Datadog/Loki/ELK/OTel-native backends with no per-vendor
// remap. Nested form (`log.level`, `service.name`, …) is the canonical ECS
// data model — cleaner JSON than dotted flat keys and pino-pretty resolves
// it via dotted key paths. The string severity label (vs pino's numeric
// `30`) and the ISO-8601 `@timestamp` are part of the same portability win.
// Kansoku ingest still accepts every legacy key during the rollout window,
// so producers and the consumer needn't restart in lock-step.
const ecsLevelFormatter = (label: string): object => ({ log: { level: label } });

const ecsBindingsFormatter = (b: pino.Bindings): object => {
  // `base` is always our `LoggerBaseBindings` (set via `base:` below); the
  // cast narrows pino's `Record<string, any>` Bindings off the `any` path.
  const base = b as LoggerBaseBindings;
  return {
    service: { name: base.service, environment: base.env, component: base.component },
    host: { name: base.hostname },
    process: { pid: base.pid },
  };
};

// pino's `timestamp` returns the raw `,"key":value` fragment, so this is the
// only place the time *key* can be renamed (`formatters` can't). `@timestamp`
// is the ECS canonical event time.
const ecsTimestamp = (): string => `,"@timestamp":"${new Date().toISOString()}"`;

// ECS error fields are `error.type` / `error.message` / `error.stack_trace`
// (no `error.name`/`error.stack`). Reuse pino's std serializer for the cause
// chain + aggregate handling, then rename `stack` → `stack_trace`.
const ecsErrorSerializer = (e: unknown): object => {
  const s = pino.stdSerializers.err(e as Error) as Record<string, unknown> & { stack?: string };
  const { stack, ...rest } = s;
  return { ...rest, stack_trace: stack };
};

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
    // ECS event time as `@timestamp` (ISO-8601), not epoch-ms `time`.
    timestamp: ecsTimestamp,
    // ECS message field (`message`, not pino's default `msg`).
    messageKey: "message",
    // Workspace error convention `logger.<level>({ error }, msg)`. `errorKey`
    // routes a bare Error first-arg to the same `error` key; the serializer
    // expands it to ECS `error.{type,message,stack_trace}` (+ cause chain).
    errorKey: "error",
    serializers: { error: ecsErrorSerializer },
    // Mixin runs on every log call and merges its return value into the
    // emitted record. Reading from AsyncLocalStorage means every log line
    // inside a traced request auto-includes the ECS trace fields without
    // callers threading context manually. The return value is the target of
    // pino's default `Object.assign(mixinObject, mergeObject)` strategy, so
    // we MUST return a fresh extensible object every call — a shared/frozen
    // sentinel would throw on any `logger.info({...}, "msg")` outside a
    // trace context.
    mixin: () => {
      const ctx = getTraceContext();
      if (!ctx) return {};
      const span: Record<string, unknown> = { id: ctx.spanId };
      if (ctx.parentSpanId) span.parent = { id: ctx.parentSpanId };
      return { trace: { id: ctx.traceId }, span };
    },
    // ECS level/bindings formatters as defaults; an explicit caller
    // `formatters.*` still wins (spread last) without losing the others.
    formatters: { level: ecsLevelFormatter, bindings: ecsBindingsFormatter, ...formatters },
  };

  // Console rendering: human-pretty on a TTY (or `LOG_PRETTY=1`), raw NDJSON
  // everywhere else — see `shouldPretty`. Run as in-process streams (not pino
  // worker-thread transports) so multistream can compose them with the
  // Kansoku shipper without bridging worker boundaries.
  const consoleStream: NodeJS.WritableStream = shouldPretty()
    ? pretty({
        colorize: true,
        translateTime: "HH:MM:ss.l",
        // Match the ECS field names so dev output still renders level/time/
        // message; hide the verbose resource objects.
        levelKey: "log.level",
        timestampKey: "@timestamp",
        messageKey: "message",
        ignore: "process,host,service",
      })
    : process.stdout;

  const logger = !kansoku
    ? pino(pinoOptions, consoleStream)
    : pino(
        pinoOptions,
        // `level` is already validated against PINO_LEVELS above; the cast
        // is safe — pino's StreamEntry just wants its narrow `Level` union.
        pino.multistream([
          { level: level as pino.Level, stream: consoleStream },
          { level: level as pino.Level, stream: createKansokuStream(kansoku) },
        ]),
      );

  // Build-light spans: emit one ECS span event per completed `runWithSpan`.
  // The explicit `trace`/`span` keys override the mixin (which, in the
  // sink's `finally`, would otherwise tag the *parent* context). Last
  // createLogger wins the sink — one logger per service in this workspace.
  setSpanSink((e) => {
    logger.info(
      {
        event: { kind: "span", name: e.name, duration_ms: e.durationMs, status: e.status },
        trace: { id: e.traceId },
        span: { id: e.spanId, ...(e.parentSpanId ? { parent: { id: e.parentSpanId } } : {}) },
      },
      "span",
    );
  });

  return logger;
}

export type { Logger } from "pino";
export type { KansokuStreamOptions } from "./kansoku-stream.js";
export type { TraceContext, SpanEndEvent } from "./trace.js";
export {
  childSpan,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  getTraceContext,
  newTraceContext,
  parseTraceparent,
  runWithSpan,
  runWithTrace,
  setSpanSink,
  withRootTrace,
} from "./trace.js";
