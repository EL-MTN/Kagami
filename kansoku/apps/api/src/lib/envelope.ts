import { z } from "zod";
import type { StoredLog } from "../storage/logs.js";

// Pino emits one object per log line. Base bindings (service/component/env)
// land at the top level alongside `time`, `level`, `msg`, and any user fields
// passed to `logger.info({ ... }, "msg")`. We accept the wire form as-is via
// passthrough and normalize into the time-series shape on the server.
export const LogEnvelope = z
  .object({
    time: z.number(),
    level: z.number(),
    service: z.string().min(1),
    component: z.string().min(1),
    env: z.string().min(1),
    msg: z.string().optional(),
    pid: z.number().optional(),
    hostname: z.string().optional(),
    traceId: z.string().optional(),
    spanId: z.string().optional(),
  })
  .passthrough();

export type LogEnvelopeInput = z.infer<typeof LogEnvelope>;

export const LogBatch = z.array(LogEnvelope).min(1).max(1000);

// Pino numeric levels → strings. Standard pino levels:
//   10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal
const LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const KNOWN_KEYS = new Set([
  "time",
  "level",
  "service",
  "component",
  "env",
  "msg",
  "pid",
  "hostname",
  "traceId",
  "spanId",
]);

export function toStoredLog(envelope: LogEnvelopeInput): StoredLog {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    if (!KNOWN_KEYS.has(k)) fields[k] = v;
  }
  if (envelope.pid !== undefined) fields.pid = envelope.pid;
  if (envelope.hostname !== undefined) fields.hostname = envelope.hostname;

  const stored: StoredLog = {
    ts: new Date(envelope.time),
    meta: {
      service: envelope.service,
      component: envelope.component,
      env: envelope.env,
      level: LEVEL_NAMES[envelope.level] ?? String(envelope.level),
    },
  };
  if (envelope.msg !== undefined) stored.msg = envelope.msg;
  if (envelope.traceId !== undefined) stored.traceId = envelope.traceId;
  if (envelope.spanId !== undefined) stored.spanId = envelope.spanId;
  if (Object.keys(fields).length > 0) stored.fields = fields;
  return stored;
}
