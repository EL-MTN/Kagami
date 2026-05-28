import type { Collection, Filter } from "mongodb";
import { getDb } from "./mongo.js";

export interface StoredLog {
  ts: Date;
  meta: {
    service: string;
    component: string;
    env: string;
    level: string;
  };
  msg?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  fields?: Record<string, unknown>;
}

async function getLogsCollection(): Promise<Collection<StoredLog>> {
  const db = await getDb();
  return db.collection<StoredLog>("logs");
}

export interface InsertLogsResult {
  insertedCount: number;
  failedCount: number;
  /** Up to 3 sample error messages for the dropped docs (driver-supplied). */
  sampleErrors: string[];
}

interface MongoBulkWriteErrorShape {
  result?: { insertedCount?: number };
  writeErrors?: Array<{ errmsg?: string }>;
}

/**
 * Bulk-insert with `ordered: false`, which lets the driver continue past
 * per-doc validation errors. The bulk call still rejects with
 * `MongoBulkWriteError`, but its `result.insertedCount` tells us how many
 * actually landed. We surface that split in the return value so the
 * caller can log accurately; full-batch failures (network, auth, etc.)
 * still throw.
 */
export async function insertLogs(docs: StoredLog[]): Promise<InsertLogsResult> {
  if (docs.length === 0) return { insertedCount: 0, failedCount: 0, sampleErrors: [] };
  const coll = await getLogsCollection();
  try {
    const result = await coll.insertMany(docs, { ordered: false });
    return { insertedCount: result.insertedCount, failedCount: 0, sampleErrors: [] };
  } catch (err) {
    const bulk = err as MongoBulkWriteErrorShape;
    const writeErrors = bulk.writeErrors ?? [];
    if (writeErrors.length === 0) {
      // Connection / auth / encoding failure — nothing landed.
      throw err;
    }
    const insertedCount = bulk.result?.insertedCount ?? 0;
    const sampleErrors = writeErrors.slice(0, 3).map((e) => e.errmsg ?? "(no errmsg)");
    return {
      insertedCount,
      failedCount: docs.length - insertedCount,
      sampleErrors,
    };
  }
}

interface QueryLogsOptions {
  service?: string;
  level?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export async function queryLogs(opts: QueryLogsOptions = {}): Promise<StoredLog[]> {
  const coll = await getLogsCollection();
  const filter: Filter<StoredLog> = {};
  if (opts.service) filter["meta.service"] = opts.service;
  if (opts.level) filter["meta.level"] = opts.level;
  if (opts.since || opts.until) {
    const tsFilter: { $gte?: Date; $lte?: Date } = {};
    if (opts.since) tsFilter.$gte = opts.since;
    if (opts.until) tsFilter.$lte = opts.until;
    filter.ts = tsFilter;
  }
  return coll
    .find(filter)
    .sort({ ts: -1 })
    .limit(Math.min(opts.limit ?? 100, 1000))
    .toArray();
}

/** All log lines that share a traceId, ordered oldest-first for waterfall rendering. */
export async function queryTrace(traceId: string): Promise<StoredLog[]> {
  const coll = await getLogsCollection();
  return coll.find({ traceId }).sort({ ts: 1 }).limit(5000).toArray();
}
