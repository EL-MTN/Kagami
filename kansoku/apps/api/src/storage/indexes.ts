import type { Db } from "mongodb";
import { getDb } from "./mongo.js";
import { logger } from "../logger.js";

// 30 days. Documented retention from kansoku/docs/architecture.md.
export const LOGS_TTL_SECONDS = 30 * 24 * 60 * 60;

// `createCollection` throws `NamespaceExists` (code 48) when the collection
// already exists. We treat that as success — the time-series options can't be
// changed in place, so a recreate would require a drop, which we won't do
// silently. If someone needs to change `granularity`, they drop the
// collection manually and restart.
const NAMESPACE_EXISTS = 48;

interface MongoCodeError {
  code?: number;
}

async function ensureTimeSeriesCollection(db: Db, name: string): Promise<void> {
  try {
    await db.createCollection(name, {
      timeseries: { timeField: "ts", metaField: "meta", granularity: "seconds" },
      expireAfterSeconds: LOGS_TTL_SECONDS,
    });
    logger.info(
      { collection: name, ttlSeconds: LOGS_TTL_SECONDS },
      "created time-series collection",
    );
  } catch (err) {
    const code = (err as MongoCodeError).code;
    if (code !== NAMESPACE_EXISTS) throw err;
  }
}

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  await ensureTimeSeriesCollection(db, "logs");

  const logs = db.collection("logs");

  // Primary slice — service timeline. Hot path for the live tail and
  // per-service search.
  await logs.createIndex({ "meta.service": 1, ts: -1 }, { name: "logs_service_ts" });

  // Single-trace fetch. Sparse so we don't index logs without a traceId
  // (everything pre-Phase 3).
  await logs.createIndex({ traceId: 1 }, { name: "logs_trace_id", sparse: true });

  // Level fan-out (e.g. error stream across services).
  await logs.createIndex({ "meta.level": 1, ts: -1 }, { name: "logs_level_ts" });

  // Error registry (Phase 4). `_id` is the fingerprint, so the primary key
  // already covers lookups; the secondary indexes drive the dashboard list.
  const errors = db.collection("errors");
  await errors.createIndex({ lastSeen: -1 }, { name: "errors_last_seen" });
  await errors.createIndex({ service: 1, lastSeen: -1 }, { name: "errors_service_last_seen" });
}
