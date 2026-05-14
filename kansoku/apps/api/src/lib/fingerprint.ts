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
 */

interface ErrorShape {
  name?: string;
  message?: string;
  topFrame?: string;
}

interface ErrorSource {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

function pickErrorObject(fields: Record<string, unknown>): ErrorShape {
  const candidate =
    pickIfObject(fields.err) ?? pickIfObject(fields.error) ?? pickIfObject(fields.cause);
  if (candidate) {
    return {
      name: typeof candidate.name === "string" ? candidate.name : undefined,
      message: typeof candidate.message === "string" ? candidate.message : undefined,
      topFrame: typeof candidate.stack === "string" ? firstStackFrame(candidate.stack) : undefined,
    };
  }

  // String shapes — caller stuffed `error.message` directly.
  const flatErr = fields.err ?? fields.error;
  if (typeof flatErr === "string") {
    return { message: flatErr };
  }

  return {};
}

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
  const signature = [log.meta.service, extracted.name ?? "", normMessage, normTop].join("␟");

  return {
    fingerprint: createHash("sha1").update(signature).digest("hex").slice(0, 16),
    name: extracted.name,
    message,
    sampleStack: extracted.topFrame,
  };
}
