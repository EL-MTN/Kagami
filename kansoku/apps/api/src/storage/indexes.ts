import type { Db } from "mongodb";
import { getDb } from "./mongo.js";
import { logger } from "../logger.js";

const SECONDS_PER_DAY = 24 * 60 * 60;
const DEFAULT_LOGS_TTL_DAYS = 30;

/**
 * Resolve the configured TTL in seconds. Bounded by a sane floor + ceiling.
 * Strict integer parsing — `"30days"` (which `parseInt` would silently
 * accept as `30`) and similar typos are rejected so the user gets a clear
 * fallback warning instead of mystery semantics.
 */
function resolveLogsTtlSeconds(): number {
  const raw = process.env.KANSOKU_LOGS_TTL_DAYS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_LOGS_TTL_DAYS * SECONDS_PER_DAY;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    logger.warn(
      { provided: raw, fallback: DEFAULT_LOGS_TTL_DAYS },
      "KANSOKU_LOGS_TTL_DAYS not a positive integer; using default",
    );
    return DEFAULT_LOGS_TTL_DAYS * SECONDS_PER_DAY;
  }
  const days = Number.parseInt(trimmed, 10);
  if (days < 1) {
    logger.warn(
      { provided: raw, fallback: DEFAULT_LOGS_TTL_DAYS },
      "KANSOKU_LOGS_TTL_DAYS must be >= 1; using default",
    );
    return DEFAULT_LOGS_TTL_DAYS * SECONDS_PER_DAY;
  }
  // Cap at 365 days — anything longer is presumably a typo (and time-series
  // bucket compaction degrades with very long retention).
  const capped = Math.min(days, 365);
  return capped * SECONDS_PER_DAY;
}

// `createCollection` throws `NamespaceExists` (code 48) when the collection
// already exists. We treat that as success and then run `collMod` to
// reconcile `expireAfterSeconds` with the current env — that's the one
// time-series option Mongo lets us change in place. Other options
// (timeField, metaField, granularity) require a manual drop + recreate.
const NAMESPACE_EXISTS = 48;

interface MongoCodeError {
  code?: number;
}

async function ensureTimeSeriesCollection(
  db: Db,
  name: string,
  expireAfterSeconds: number,
): Promise<void> {
  try {
    await db.createCollection(name, {
      timeseries: { timeField: "ts", metaField: "meta", granularity: "seconds" },
      expireAfterSeconds,
    });
    logger.info(
      { collection: name, ttlSeconds: expireAfterSeconds },
      "created time-series collection",
    );
    return;
  } catch (err) {
    const code = (err as MongoCodeError).code;
    if (code !== NAMESPACE_EXISTS) throw err;
  }

  // Collection already exists — reconcile the TTL with `collMod`. Idempotent
  // when expireAfterSeconds already matches. Some Mongo deployments (e.g.
  // older mongodb-memory-server builds) reject `collMod` on time-series
  // collections with code 167 — treat that as best-effort and continue.
  try {
    await db.command({ collMod: name, expireAfterSeconds });
    logger.info({ collection: name, ttlSeconds: expireAfterSeconds }, "reconciled time-series TTL");
  } catch (err) {
    const code = (err as MongoCodeError).code;
    if (code === 167) {
      logger.warn(
        { collection: name, err: (err as Error).message },
        "server rejected collMod on time-series; existing TTL kept",
      );
      return;
    }
    throw err;
  }
}

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  const logsTtlSeconds = resolveLogsTtlSeconds();

  await ensureTimeSeriesCollection(db, "logs", logsTtlSeconds);

  const logs = db.collection("logs");

  // Primary slice — service timeline. Hot path for the live tail and
  // per-service search.
  await logs.createIndex({ "meta.service": 1, ts: -1 }, { name: "logs_service_ts" });

  // Single-trace fetch. Time-series collections don't support `sparse`
  // (or `partialFilterExpression`) on indexes; post-Phase 3 every log
  // carries a traceId from the trace middleware anyway, so a dense
  // index is fine.
  await logs.createIndex({ traceId: 1 }, { name: "logs_trace_id" });

  // Level fan-out (e.g. error stream across services).
  await logs.createIndex({ "meta.level": 1, ts: -1 }, { name: "logs_level_ts" });

  // Error registry (Phase 4). `_id` is the fingerprint, so the primary key
  // already covers lookups; the secondary indexes drive the dashboard list.
  const errors = db.collection("errors");
  await errors.createIndex({ lastSeen: -1 }, { name: "errors_last_seen" });
  await errors.createIndex({ service: 1, lastSeen: -1 }, { name: "errors_service_last_seen" });
}
