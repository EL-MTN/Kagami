import type { Collection } from "mongodb";
import { getDb } from "./mongo.js";
import type { StoredLog } from "./logs.js";

// Phase 6 metrics are derived on read — no second ingestion pipeline. The
// log time-series collection (already indexed on `meta.service` + `ts` from
// Phase 1) is the only data source. At Kagami's personal scale (10–100
// logs/sec peak) these aggregations are fast enough to run on every page
// load without caching.

async function getLogsCollection(): Promise<Collection<StoredLog>> {
  const db = await getDb();
  return db.collection<StoredLog>("logs");
}

/**
 * Distinct service names across all retained logs, sorted. Uses `distinct` on
 * the time-series metaField (`meta.service`) so it reads bucket metadata rather
 * than scanning measurements — cheap and bounded only by retention (not a time
 * window), so quiet-but-retained services stay discoverable in filter dropdowns
 * regardless of how high KANSOKU_LOGS_TTL_DAYS is set.
 */
export async function distinctServiceNames(): Promise<string[]> {
  const coll = await getLogsCollection();
  const names = (await coll.distinct("meta.service")) as string[];
  return names.filter((s) => typeof s === "string" && s.length > 0).sort();
}

interface ServiceSummary {
  service: string;
  count: number;
  errorCount: number;
  warnCount: number;
  lastSeen: Date | null;
  components: string[];
}

interface ServiceSummaryOptions {
  /** Absolute lower bound on `ts`. Required so the aggregation can hit the index. */
  since: Date;
}

export async function serviceSummary(opts: ServiceSummaryOptions): Promise<ServiceSummary[]> {
  const coll = await getLogsCollection();
  const rows = (await coll
    .aggregate([
      { $match: { ts: { $gte: opts.since } } },
      {
        $group: {
          _id: "$meta.service",
          count: { $sum: 1 },
          errorCount: {
            $sum: { $cond: [{ $in: ["$meta.level", ["error", "fatal"]] }, 1, 0] },
          },
          warnCount: {
            $sum: { $cond: [{ $eq: ["$meta.level", "warn"] }, 1, 0] },
          },
          lastSeen: { $max: "$ts" },
          components: { $addToSet: "$meta.component" },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray()) as Array<{
    _id: string;
    count: number;
    errorCount: number;
    warnCount: number;
    lastSeen: Date;
    components: string[];
  }>;

  return rows.map((r) => ({
    service: r._id,
    count: r.count,
    errorCount: r.errorCount,
    warnCount: r.warnCount,
    lastSeen: r.lastSeen ?? null,
    components: r.components.sort(),
  }));
}

export type TimelineGranularity = "minute" | "hour" | "day";

interface ServiceTimelineBucket {
  ts: Date;
  count: number;
  errorCount: number;
}

interface ServiceTimelineOptions {
  service: string;
  since: Date;
  granularity: TimelineGranularity;
}

/**
 * Bucketed per-level counts for one service. Used by the dashboard's
 * sparkline + error-rate visualisations.
 *
 * Buckets that have zero events are not returned — the caller fills the
 * gaps to keep the SVG path geometry correct without making the index do
 * unnecessary work.
 */
export async function serviceTimeline(
  opts: ServiceTimelineOptions,
): Promise<ServiceTimelineBucket[]> {
  const coll = await getLogsCollection();
  const rows = (await coll
    .aggregate([
      { $match: { ts: { $gte: opts.since }, "meta.service": opts.service } },
      {
        $group: {
          _id: { $dateTrunc: { date: "$ts", unit: opts.granularity } },
          count: { $sum: 1 },
          errorCount: {
            $sum: { $cond: [{ $in: ["$meta.level", ["error", "fatal"]] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray()) as Array<{ _id: Date; count: number; errorCount: number }>;

  return rows.map((r) => ({ ts: r._id, count: r.count, errorCount: r.errorCount }));
}
