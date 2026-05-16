import { z } from "zod";
import { guardMeta } from "./cardinality.js";
import type { StoredLog } from "../storage/logs.js";

// Bound on the on-wire meta dimensions (service/component/env). A single
// pathological value (a stack trace stuffed into `component`, say) shouldn't
// be storable; the distinct-tuple budget in cardinality.ts handles the
// many-distinct-values case, this handles the one-huge-value case.
const MAX_META_LEN = 64;

// `time` accepted as epoch-ms `number` (legacy pino) OR an ISO-8601 `string`
// (current `@kagami/logger`, `pino.stdTimeFunctions.isoTime`). Both forms are
// in flight across a producer-restart window, so ingest tolerates either and
// normalizes to a Date — see toStoredLog.
const TimeField = z.union([
  z.number(),
  z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid ISO-8601 timestamp" }),
]);

// `level` accepted as pino numeric (legacy) OR string label (current
// `@kagami/logger` `formatters.level`). Normalized to a known lowercase name
// in toStoredLog.
const LevelField = z.union([z.number(), z.string().min(1)]);

// Pino emits one object per log line. Base bindings (service/component/env)
// land at the top level alongside `time`, `level`, `msg`, and any user fields
// passed to `logger.info({ ... }, "msg")`. We accept the wire form as-is via
// passthrough and normalize into the time-series shape on the server.
export const LogEnvelope = z
  .object({
    time: TimeField,
    level: LevelField,
    service: z.string().min(1).max(MAX_META_LEN),
    component: z.string().min(1).max(MAX_META_LEN),
    env: z.string().min(1).max(MAX_META_LEN),
    msg: z.string().optional(),
    pid: z.number().optional(),
    hostname: z.string().optional(),
    traceId: z.string().optional(),
    spanId: z.string().optional(),
    parentSpanId: z.string().optional(),
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
const KNOWN_LEVEL_NAMES = new Set<string>(Object.values(LEVEL_NAMES));

// Normalize either wire form to a bounded set of names. An unrecognized
// numeric level or an off-vocabulary string both collapse to "unknown"
// rather than passing through verbatim — a stray `String(level)` used to be
// an unbounded `meta.level` cardinality leak (one bucket per junk value).
function normalizeLevel(level: number | string): string {
  if (typeof level === "number") return LEVEL_NAMES[level] ?? "unknown";
  const lc = level.toLowerCase();
  return KNOWN_LEVEL_NAMES.has(lc) ? lc : "unknown";
}

// `number` is epoch-ms, `string` is ISO-8601 (schema already proved it
// `Date.parse`-able). `new Date` handles both.
function normalizeTime(time: number | string): Date {
  return new Date(time);
}

// Keys we recognize and lift to typed slots on StoredLog. Anything else
// passes through into `fields`. We also reserve a few storage-layer keys
// (`ts`, `_id`, `meta`) so a shipper can't smuggle them into `fields` and
// confuse search/query handlers that read them as if they were real
// document attributes.
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
  "parentSpanId",
]);
const RESERVED_STORAGE_KEYS = new Set(["ts", "_id", "meta", "fields"]);

export function toStoredLog(envelope: LogEnvelopeInput): StoredLog {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    if (KNOWN_KEYS.has(k)) continue;
    // Drop reserved storage keys — they'd alias the time-series doc shape.
    if (RESERVED_STORAGE_KEYS.has(k)) continue;
    fields[k] = v;
  }
  if (envelope.pid !== undefined) fields.pid = envelope.pid;
  if (envelope.hostname !== undefined) fields.hostname = envelope.hostname;

  const stored: StoredLog = {
    ts: normalizeTime(envelope.time),
    // Cardinality guard runs last so the budget counts post-normalization
    // tuples (numeric 30 and string "info" are the same bucket).
    meta: guardMeta({
      service: envelope.service,
      component: envelope.component,
      env: envelope.env,
      level: normalizeLevel(envelope.level),
    }),
  };
  if (envelope.msg !== undefined) stored.msg = envelope.msg;
  if (envelope.traceId !== undefined) stored.traceId = envelope.traceId;
  if (envelope.spanId !== undefined) stored.spanId = envelope.spanId;
  if (envelope.parentSpanId !== undefined) stored.parentSpanId = envelope.parentSpanId;
  if (Object.keys(fields).length > 0) stored.fields = fields;
  return stored;
}
