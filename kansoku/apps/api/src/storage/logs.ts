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
  /** Single level or a list — a list maps to `{ "meta.level": { $in: [...] } }`. */
  level?: string | string[];
  since?: Date;
  until?: Date;
  limit?: number;
}

export async function queryLogs(opts: QueryLogsOptions = {}): Promise<StoredLog[]> {
  const coll = await getLogsCollection();
  const filter: Filter<StoredLog> = {};
  if (opts.service) filter["meta.service"] = opts.service;
  if (opts.level !== undefined) {
    if (Array.isArray(opts.level)) {
      if (opts.level.length > 0) filter["meta.level"] = { $in: opts.level };
    } else {
      filter["meta.level"] = opts.level;
    }
  }
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

export interface TraceSummary {
  traceId: string;
  startedAt: string; // ISO — min(ts) across the trace
  services: string[]; // distinct meta.service, sorted
  rootService: string; // meta.service of the earliest log
  rootMsg: string; // msg of the earliest log
  logCount: number;
  spanCount: number; // distinct spanIds
  durationMs: number; // max(ts) - min(ts)
  errorCount: number; // logs with level in (error, fatal)
}

interface ListTracesOptions {
  limit?: number;
  since?: Date;
  until?: Date;
  service?: string;
}

// Cap the number of raw log docs the trace-summary aggregation scans, so an
// unbounded window can't fan out an arbitrarily large $group. At Kagami's
// scale this comfortably covers the recent traces a dashboard list needs.
const TRACE_SCAN_CAP = 50_000;
// Default lookback when the caller gives no `since`, so a bare all-services
// list is bounded by the time-series time index instead of sorting the whole
// retained traced-log set. The dashboard always sends an explicit window.
const DEFAULT_TRACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Aggregate the `logs` time-series collection into one TraceSummary per
 * traceId, newest-first by startedAt. Logs without a traceId are excluded.
 * The earliest log in each trace supplies rootService/rootMsg; spanCount is
 * the count of distinct spanIds; durationMs is max(ts)-min(ts); errorCount
 * counts error/fatal lines; services is the distinct set of meta.service.
 *
 * The scan is bounded two ways: a time window ($match on ts, defaulting to the
 * last 7d so the time index can satisfy the $sort before TRACE_SCAN_CAP). When
 * a `service` is given we first resolve the traces that *involve* it, then
 * aggregate the FULL traces — matching by service before the $group would
 * compute each summary (root, errors, services, duration) from only that
 * service's slice of a cross-service trace, disagreeing with the trace detail.
 */
export async function listTraces(opts: ListTracesOptions = {}): Promise<TraceSummary[]> {
  const coll = await getLogsCollection();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  // Anchor the default window on `until` when given, so an until-only historical
  // query gets a [until-7d, until] window instead of an empty [now-7d, until];
  // otherwise anchor on now. An explicit `since` always wins.
  const anchorEnd = opts.until ?? new Date();
  const since = opts.since ?? new Date(anchorEnd.getTime() - DEFAULT_TRACE_WINDOW_MS);
  const tsFilter: { $gte: Date; $lte?: Date } = { $gte: since };
  if (opts.until) tsFilter.$lte = opts.until;

  // Service filter: resolve the most-recent traces that involve this service in
  // the window first, then (below) aggregate their full cross-service logs.
  let traceScope: string[] | undefined;
  if (opts.service) {
    const ids = (await coll
      .aggregate([
        {
          $match: {
            "meta.service": opts.service,
            traceId: { $exists: true, $ne: "" },
            ts: tsFilter,
          },
        },
        { $group: { _id: "$traceId", startedAt: { $min: "$ts" } } },
        { $sort: { startedAt: -1 } },
        { $limit: limit },
      ])
      .toArray()) as Array<{ _id: string }>;
    traceScope = ids.map((d) => d._id);
    if (traceScope.length === 0) return [];
  }

  // Exclude logs with no traceId (defensive against absent/empty values so they
  // don't aggregate into a phantom "" trace). With a service scope, match the
  // resolved traces by id — full traces, no slice, no ts bound (already ≤ limit).
  const match: Filter<StoredLog> = traceScope
    ? { traceId: { $in: traceScope } }
    : { traceId: { $exists: true, $ne: "" }, ts: tsFilter };

  const rows = (await coll
    .aggregate([
      { $match: match },
      // Newest docs first so the scan cap keeps the most recent activity, and
      // so $last within each group lands on the earliest log (root) after the
      // group's internal ordering is by descending ts.
      { $sort: { ts: -1 } },
      { $limit: TRACE_SCAN_CAP },
      {
        $group: {
          _id: "$traceId",
          startedAt: { $min: "$ts" },
          endedAt: { $max: "$ts" },
          logCount: { $sum: 1 },
          errorCount: {
            $sum: { $cond: [{ $in: ["$meta.level", ["error", "fatal"]] }, 1, 0] },
          },
          services: { $addToSet: "$meta.service" },
          spanIds: { $addToSet: "$spanId" },
          // Docs arrive ts-descending, so the last one in the group is the
          // earliest log — the trace root.
          rootService: { $last: "$meta.service" },
          rootMsg: { $last: "$msg" },
        },
      },
      { $sort: { startedAt: -1 } },
      { $limit: limit },
    ])
    .toArray()) as Array<{
    _id: string;
    startedAt: Date;
    endedAt: Date;
    logCount: number;
    errorCount: number;
    services: string[];
    spanIds: Array<string | null | undefined>;
    rootService: string;
    rootMsg?: string;
  }>;

  return rows.map((r) => ({
    traceId: r._id,
    startedAt: r.startedAt.toISOString(),
    services: r.services.filter((s): s is string => typeof s === "string").sort(),
    rootService: r.rootService,
    rootMsg: r.rootMsg ?? "",
    logCount: r.logCount,
    spanCount: r.spanIds.filter((s) => typeof s === "string" && s.length > 0).length,
    durationMs: r.endedAt.getTime() - r.startedAt.getTime(),
    errorCount: r.errorCount,
  }));
}
