import type { Collection } from "mongodb";
import { getDb } from "./mongo.js";
import { logger } from "../logger.js";
import type { StoredLog } from "./logs.js";

// Build-light spans. A span-end event arrives as an ordinary ECS log line
// (`event.kind === "span"`, see @kagami/logger `runWithSpan`); it's stored
// in `logs` like any line AND folded here into a derived `spans` collection
// keyed `traceId:spanId` so the trace waterfall has real durations + a
// parent/child tree instead of guessing from log timestamps.

export interface StoredSpan {
  _id: string; // `${traceId}:${spanId}` — idempotent on a shipper resend
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  service: string;
  component: string;
  startedAt: Date;
  durationMs: number;
  status: "ok" | "error";
}

async function getSpansCollection(): Promise<Collection<StoredSpan>> {
  const db = await getDb();
  return db.collection<StoredSpan>("spans");
}

interface SpanEventFields {
  event?: { kind?: unknown; name?: unknown; duration_ms?: unknown; status?: unknown };
}

/**
 * Pull a StoredSpan out of a normalized log doc, or undefined if it isn't a
 * span event (or is missing the identity/timing needed to place it on a
 * waterfall). `trace.id` / `span.id` / `span.parent.id` were already lifted
 * onto the StoredLog by the envelope normalizer; the lifecycle payload rode
 * along under `fields.event`.
 */
export function extractSpan(doc: StoredLog): StoredSpan | undefined {
  const ev = (doc.fields as SpanEventFields | undefined)?.event;
  if (!ev || ev.kind !== "span") return undefined;
  if (!doc.traceId || !doc.spanId) return undefined;
  if (typeof ev.name !== "string" || typeof ev.duration_ms !== "number") return undefined;
  const status = ev.status === "error" ? "error" : "ok";

  const span: StoredSpan = {
    _id: `${doc.traceId}:${doc.spanId}`,
    traceId: doc.traceId,
    spanId: doc.spanId,
    name: ev.name,
    service: doc.meta.service,
    component: doc.meta.component,
    startedAt: doc.ts,
    durationMs: ev.duration_ms,
    status,
  };
  if (doc.parentSpanId !== undefined) span.parentSpanId = doc.parentSpanId;
  return span;
}

/**
 * Upsert the span docs in `docs` (the ones that are span events). Idempotent
 * on `_id` so a shipper resend can't double-insert. Fail-soft per the
 * observability posture: a spans write must never wedge ingest.
 */
export async function recordSpans(docs: StoredLog[]): Promise<void> {
  const spans = docs.map(extractSpan).filter((s): s is StoredSpan => s !== undefined);
  if (spans.length === 0) return;
  const coll = await getSpansCollection();
  const results = await Promise.allSettled(
    spans.map((s) => {
      const { _id, ...rest } = s;
      return coll.updateOne({ _id }, { $set: rest }, { upsert: true });
    }),
  );
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    logger.warn(
      {
        failed: failures.length,
        total: spans.length,
        sample:
          (failures[0] as PromiseRejectedResult).reason instanceof Error
            ? ((failures[0] as PromiseRejectedResult).reason as Error).message
            : String((failures[0] as PromiseRejectedResult).reason),
      },
      "kansoku spans: partial upsert failure",
    );
  }
}

/** All spans on a trace, oldest-first for waterfall rendering. */
export async function querySpansByTrace(traceId: string): Promise<StoredSpan[]> {
  const coll = await getSpansCollection();
  return coll.find({ traceId }).sort({ startedAt: 1 }).limit(5000).toArray();
}
