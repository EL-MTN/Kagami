import { z } from "zod";
import { guardMeta } from "./cardinality.js";
import type { StoredLog } from "../storage/logs.js";

// Ingest accepts BOTH wire shapes and normalizes to the same internal
// StoredLog, so the producer fleet and this consumer never have to restart
// in lock-step:
//
//   ECS / OTel (current @kagami/logger): nested
//     { "@timestamp": iso, log:{level}, service:{name,environment,component},
//       host:{name}, process:{pid}, trace:{id}, span:{id,parent:{id}},
//       message, error:{type,message,stack_trace}, ... }
//
//   Legacy (pre-ECS pino): flat
//     { time: epoch-ms|iso, level: number|string, service, component, env,
//       msg, pid, hostname, traceId, spanId, parentSpanId, ... }
//
// Everything downstream (queries, metrics, errors, dashboard) reads the
// normalized StoredLog, so the rename stays contained to this file
// (+ fingerprint.ts error-shape tolerance + the shipper's level read).

const MAX_META_LEN = 64;

const LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};
const KNOWN_LEVEL_NAMES = new Set<string>(Object.values(LEVEL_NAMES));

// Unrecognized numeric level or off-vocabulary string → "unknown" rather
// than verbatim: a stray `String(level)` was an unbounded `meta.level`
// cardinality leak (one bucket per junk value).
function normalizeLevel(level: number | string): string {
  if (typeof level === "number") return LEVEL_NAMES[level] ?? "unknown";
  const lc = level.toLowerCase();
  return KNOWN_LEVEL_NAMES.has(lc) ? lc : "unknown";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isParseableTime(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return !Number.isNaN(Date.parse(v));
  return false;
}

interface NormalizedEnvelope {
  ts: Date;
  service: string;
  component: string;
  env: string;
  level: string;
  msg?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  fields: Record<string, unknown>;
}

// Keys consumed by extraction (either shape) plus storage-layer keys a
// shipper must not be able to smuggle into `fields`. Everything not here —
// including `error`, `sampled`, and arbitrary user fields — passes through.
const CONSUMED_KEYS = new Set([
  "@timestamp",
  "time",
  "log",
  "level",
  "service",
  "component",
  "env",
  "message",
  "msg",
  "trace",
  "traceId",
  "span",
  "spanId",
  "parentSpanId",
  "process",
  "pid",
  "host",
  "hostname",
  // storage-layer aliases
  "ts",
  "_id",
  "meta",
  "fields",
]);

type ParseResult = { ok: true; value: NormalizedEnvelope } | { ok: false; issues: string[] };

/**
 * Resolve one wire object (either shape) to the normalized intermediate, or
 * a list of validation issues. ECS fields win when both are present so a
 * half-migrated producer can't regress to the legacy slot.
 */
function parseEnvelope(obj: unknown): ParseResult {
  if (!isRecord(obj)) return { ok: false, issues: ["envelope must be an object"] };

  const ecsService = isRecord(obj.service) ? obj.service : undefined;
  const ecsLog = isRecord(obj.log) ? obj.log : undefined;
  const ecsTrace = isRecord(obj.trace) ? obj.trace : undefined;
  const ecsSpan = isRecord(obj.span) ? obj.span : undefined;
  const ecsSpanParent = ecsSpan && isRecord(ecsSpan.parent) ? ecsSpan.parent : undefined;
  const ecsProc = isRecord(obj.process) ? obj.process : undefined;
  const ecsHost = isRecord(obj.host) ? obj.host : undefined;

  const issues: string[] = [];

  // timestamp
  const rawTime = obj["@timestamp"] ?? obj.time;
  if (!isParseableTime(rawTime)) issues.push("missing or invalid timestamp (@timestamp / time)");

  // level
  const rawLevel = ecsLog?.level ?? obj.level;
  if (typeof rawLevel !== "string" && typeof rawLevel !== "number") {
    issues.push("missing level (log.level / level)");
  }

  // meta strings — ECS object form vs legacy flat string
  const service = ecsService ? ecsService.name : obj.service;
  const env = ecsService ? ecsService.environment : obj.env;
  const component = ecsService ? ecsService.component : obj.component;
  const checkMeta = (name: string, v: unknown): string | undefined => {
    if (typeof v !== "string" || v.length < 1) {
      issues.push(`missing ${name}`);
      return undefined;
    }
    if (v.length > MAX_META_LEN) {
      issues.push(`${name} exceeds ${MAX_META_LEN} chars`);
      return undefined;
    }
    return v;
  };
  const svc = checkMeta("service", service);
  const cmp = checkMeta("component", component);
  const ev = checkMeta("env", env);

  if (issues.length > 0) return { ok: false, issues };

  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!CONSUMED_KEYS.has(k)) fields[k] = v;
  }
  // Keep pid/hostname queryable under `fields` (either wire shape).
  const pid = ecsProc?.pid ?? obj.pid;
  const hostname = ecsHost?.name ?? obj.hostname;
  if (pid !== undefined) fields.pid = pid;
  if (hostname !== undefined) fields.hostname = hostname;

  const value: NormalizedEnvelope = {
    ts: new Date(rawTime as string | number),
    service: svc as string,
    component: cmp as string,
    env: ev as string,
    level: normalizeLevel(rawLevel as string | number),
    fields,
  };
  const msg = str(obj.message) ?? str(obj.msg);
  const traceId = str(ecsTrace?.id) ?? str(obj.traceId);
  const spanId = str(ecsSpan?.id) ?? str(obj.spanId);
  const parentSpanId = str(ecsSpanParent?.id) ?? str(obj.parentSpanId);
  if (msg !== undefined) value.msg = msg;
  if (traceId !== undefined) value.traceId = traceId;
  if (spanId !== undefined) value.spanId = spanId;
  if (parentSpanId !== undefined) value.parentSpanId = parentSpanId;

  return { ok: true, value };
}

// Permissive on the wire (either shape, passthrough); the real contract is
// enforced in `parseEnvelope` so a malformed batch still fails closed with
// 400 rather than throwing a 500 out of the normalizer.
export const LogEnvelope = z
  .object({})
  .passthrough()
  .superRefine((obj, ctx) => {
    const result = parseEnvelope(obj);
    if (!result.ok) {
      for (const message of result.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      }
    }
  });

type LogEnvelopeInput = Record<string, unknown>;

export const LogBatch = z.array(LogEnvelope).min(1).max(1000);

export function toStoredLog(envelope: LogEnvelopeInput): StoredLog {
  const result = parseEnvelope(envelope);
  // LogBatch.parse already ran parseEnvelope via superRefine, so this only
  // throws on a programming error (toStoredLog called on unvalidated input).
  if (!result.ok) {
    throw new Error(`toStoredLog on invalid envelope: ${result.issues.join("; ")}`);
  }
  const e = result.value;

  const stored: StoredLog = {
    ts: e.ts,
    // Cardinality guard runs on the normalized tuple (numeric 30 / "info" /
    // ECS log.level all collapse to the same bucket).
    meta: guardMeta({
      service: e.service,
      component: e.component,
      env: e.env,
      level: e.level,
    }),
  };
  if (e.msg !== undefined) stored.msg = e.msg;
  if (e.traceId !== undefined) stored.traceId = e.traceId;
  if (e.spanId !== undefined) stored.spanId = e.spanId;
  if (e.parentSpanId !== undefined) stored.parentSpanId = e.parentSpanId;
  if (Object.keys(e.fields).length > 0) stored.fields = e.fields;
  return stored;
}
