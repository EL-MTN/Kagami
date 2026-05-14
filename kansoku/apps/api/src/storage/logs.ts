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

export async function insertLogs(docs: StoredLog[]): Promise<void> {
  if (docs.length === 0) return;
  const coll = await getLogsCollection();
  await coll.insertMany(docs, { ordered: false });
}

export interface QueryLogsOptions {
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
