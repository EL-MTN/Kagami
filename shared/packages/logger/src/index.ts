import { hostname } from "node:os";
import pino from "pino";
import pretty from "pino-pretty";
import type { LoggerOptions } from "pino";
import { createKansokuStream } from "./kansoku-stream.js";
import type { KansokuStreamOptions } from "./kansoku-stream.js";
import { getTraceContext } from "./trace.js";

export const DEFAULT_REDACT_PATHS = [
  "authorization",
  "cookie",
  "password",
  "token",
  "apiKey",
  "api_key",
  "secret",
  "accessToken",
  "refreshToken",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.token",
  "*.apiKey",
  "*.api_key",
  "*.secret",
  "*.accessToken",
  "*.refreshToken",
  // Base64 image payloads: scrubbed before they can leave the process. Belt
  // for the centralized logger's mouth — covers Kokoro's existing shape plus
  // common nesting one level deep.
  "imageData",
  "*.imageData",
  "message.imageData",
  "messages[*].imageData",
];

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

  const pinoOptions: LoggerOptions = {
    level,
    base: buildLoggerBase({ service, component, env }),
    redact: {
      paths: DEFAULT_REDACT_PATHS,
      censor: (value, path) => {
        const tail = path[path.length - 1];
        if (tail === "imageData" && typeof value === "string") {
          return `[base64 omitted, ~${value.length}b]`;
        }
        return "[redacted]";
      },
    },
    // Mixin runs on every log call and merges its return value into the
    // emitted record. Reading from AsyncLocalStorage means every log line
    // inside a traced request auto-includes traceId/spanId without callers
    // having to thread context manually.
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
  // Cast `level` to pino.Level: pino's StreamEntry types the field as its
  // narrow union ("trace" | "debug" | …) but the LoggerOptions level field
  // happily accepts any string. We pass-through whatever the caller set;
  // pino itself decides whether to honor it at write time.
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
} from "./trace.js";
