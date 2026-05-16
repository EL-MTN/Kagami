import { createHash } from "node:crypto";
import type { StoredLog } from "../storage/logs.js";

/**
 * Build a stable fingerprint from an error log. The goal is to group log
 * lines that represent the same underlying failure, even when their messages
 * include varying IDs, timestamps, or counts.
 *
 * Extraction is best-effort and tolerates the shapes we actually see in
 * Kioku/Kokoro/Kizuna call sites:
 *   logger.error({ err: error.message }, "msg")           → fields.err string
 *   logger.error({ err: { name, message, stack } }, ...)  → fields.err object
 *   logger.error({ error: error }, ...)                   → fields.error
 *   logger.error("just a message")                        → top-level msg only
 *
 * We also walk `Error.cause` chains (bounded depth) and pick up the first
 * inner error of an `AggregateError`, so a wrapper Error that rethrows with
 * context doesn't collapse two distinct underlying failures into one bucket.
 */

interface ErrorShape {
  name?: string;
  message?: string;
  topFrame?: string;
  /** Joined "name:message" pairs walking the cause chain, oldest-first. */
  causeChain?: string;
}

interface ErrorSource {
  name?: unknown;
  // ECS uses `type` (not `name`) and `stack_trace` (not `stack`). Accept
  // both so error grouping is stable whether a line arrives ECS or legacy.
  type?: unknown;
  message?: unknown;
  stack?: unknown;
  stack_trace?: unknown;
  cause?: unknown;
  errors?: unknown;
}

const MAX_CAUSE_DEPTH = 3;

function pickIfObject(v: unknown): ErrorSource | undefined {
  if (typeof v === "object" && v !== null) return v;
  return undefined;
}

function firstStackFrame(stack: string): string | undefined {
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    if (trimmed.includes("node:internal")) continue;
    return trimmed;
  }
  return undefined;
}

function errName(src: ErrorSource): string {
  if (typeof src.name === "string") return src.name;
  if (typeof src.type === "string") return src.type;
  return "";
}

function errStack(src: ErrorSource): string | undefined {
  if (typeof src.stack === "string") return src.stack;
  if (typeof src.stack_trace === "string") return src.stack_trace;
  return undefined;
}

function summarize(src: ErrorSource): string {
  const message = typeof src.message === "string" ? src.message : "";
  return `${errName(src)}:${message}`;
}

/**
 * Walk `.cause` (bounded depth) and, for `AggregateError`-shaped objects,
 * include the first inner error. Returns a normalized chain string used as
 * an extra hash input — distinguishes two outer errors with the same
 * message but different underlying causes.
 */
function buildCauseChain(src: ErrorSource): string {
  const parts: string[] = [];
  // First-inner of AggregateError-style { errors: [...] }.
  if (Array.isArray(src.errors) && src.errors.length > 0) {
    const inner = pickIfObject(src.errors[0]);
    if (inner) parts.push(`agg(${summarize(inner)})`);
  }
  let current: ErrorSource | undefined = pickIfObject(src.cause);
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth += 1) {
    parts.push(summarize(current));
    current = pickIfObject(current.cause);
  }
  return parts.join(" -> ");
}

function pickErrorObject(fields: Record<string, unknown>): ErrorShape {
  const candidate =
    pickIfObject(fields.err) ?? pickIfObject(fields.error) ?? pickIfObject(fields.cause);
  if (candidate) {
    const name = errName(candidate);
    const stack = errStack(candidate);
    return {
      name: name === "" ? undefined : name,
      message: typeof candidate.message === "string" ? candidate.message : undefined,
      topFrame: stack ? firstStackFrame(stack) : undefined,
      causeChain: buildCauseChain(candidate),
    };
  }

  // String shapes — caller stuffed `error.message` directly.
  const flatErr = fields.err ?? fields.error;
  if (typeof flatErr === "string") {
    return { message: flatErr };
  }

  return {};
}

// Replace volatile parts of the signature so the same underlying failure
// hashes to the same fingerprint across occurrences. Keep the patterns
// conservative — overly aggressive normalization would collapse distinct
// errors that happen to look similar.
const NORMALIZERS: { pattern: RegExp; replacement: string }[] = [
  // ISO-8601 timestamps
  { pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, replacement: "<ts>" },
  // UUIDs
  {
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: "<uuid>",
  },
  // Mongo ObjectIds
  { pattern: /\b[0-9a-f]{24}\b/gi, replacement: "<id>" },
  // Long numeric runs (>5 digits — keep small numbers like status codes intact).
  { pattern: /\b\d{6,}\b/g, replacement: "<n>" },
];

export function normalizeForFingerprint(input: string): string {
  let out = input;
  for (const { pattern, replacement } of NORMALIZERS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export interface ErrorFingerprint {
  fingerprint: string;
  name?: string;
  message: string;
  sampleStack?: string;
}

/**
 * Compute the fingerprint for an error log line. Returns `undefined` when
 * there's no signal at all to hash on — we'd rather skip a row than create
 * a catch-all bucket that swallows everything.
 */
export function fingerprintErrorLog(log: StoredLog): ErrorFingerprint | undefined {
  const fields = log.fields ?? {};
  const extracted = pickErrorObject(fields);
  const message = extracted.message ?? log.msg;
  if (!message) return undefined;

  const normMessage = normalizeForFingerprint(message);
  const normTop = extracted.topFrame ? normalizeForFingerprint(extracted.topFrame) : "";
  const normCause = extracted.causeChain ? normalizeForFingerprint(extracted.causeChain) : "";
  const signature = [log.meta.service, extracted.name ?? "", normMessage, normTop, normCause].join(
    "␟",
  );

  return {
    fingerprint: createHash("sha1").update(signature).digest("hex").slice(0, 16),
    name: extracted.name,
    message,
    sampleStack: extracted.topFrame,
  };
}
