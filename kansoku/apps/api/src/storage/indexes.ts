import type { Db } from "mongodb";
import { getDb } from "./mongo.js";
import { loadEnv } from "../config.js";
import { logger } from "../logger.js";

const SECONDS_PER_DAY = 24 * 60 * 60;
const MAX_TTL_DAYS = 365;

/**
 * Convert a day-valued TTL (validated by the env spec) to seconds, capped at
 * 365 days. Anything longer is presumably a typo (and, for the time-series
 * logs collection, bucket compaction degrades with very long retention).
 * The errors-registry rationale: errors are fingerprinted + deduped, so the
 * registry grows far slower than `logs`, but fingerprint fragmentation (a
 * stack frame that varies, an inlined id the normalizer misses) still
 * accretes rows unboundedly — keyed on `lastSeen`, a fingerprint that stops
 * recurring ages out while an active one keeps refreshing. The 90-day
 * default is long enough that a quarterly-recurring bug is still grouped,
 * not a fresh fingerprint.
 */
function ttlSeconds(days: number): number {
  return Math.min(days, MAX_TTL_DAYS) * SECONDS_PER_DAY;
}

// `createCollection` throws `NamespaceExists` (code 48) when the collection
// already exists. We treat that as success and then run `collMod` to
// reconcile `expireAfterSeconds` with the current env — that's the one
// time-series option Mongo lets us change in place. Other options
// (timeField, metaField, granularity) require a manual drop + recreate.
const NAMESPACE_EXISTS = 48;
// createIndex throws one of these when an index with the same name/key
// already exists but with different options (e.g. a pre-existing
// non-TTL `errors_last_seen` from before this change). We then reconcile
// the TTL in place via `collMod` — the same idempotent-on-restart posture
// as the time-series TTL above.
const INDEX_OPTIONS_CONFLICT = 85;
const INDEX_KEY_SPECS_CONFLICT = 86;

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

/**
 * Create `keySpec` as a TTL index, or reconcile an existing same-named index
 * to `expireAfterSeconds` if it predates the TTL (or its window changed).
 * `errors` is a regular collection — a normal single-field TTL index works
 * here (unlike the time-series `logs` collection, whose TTL is a collection
 * option reconciled via `collMod` in `ensureTimeSeriesCollection`).
 */
async function ensureTtlIndex(
  db: Db,
  collName: string,
  keySpec: Record<string, 1 | -1>,
  name: string,
  expireAfterSeconds: number,
): Promise<void> {
  try {
    await db.collection(collName).createIndex(keySpec, { name, expireAfterSeconds });
    return;
  } catch (err) {
    const code = (err as MongoCodeError).code;
    if (code !== INDEX_OPTIONS_CONFLICT && code !== INDEX_KEY_SPECS_CONFLICT) throw err;
  }
  // Same name/key, different (or absent) TTL — adjust it in place.
  await db.command({ collMod: collName, index: { name, expireAfterSeconds } });
  logger.info({ collection: collName, index: name, expireAfterSeconds }, "reconciled TTL index");
}

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  // Read per call (not module scope) so a TTL env change is picked up by the
  // collMod reconciliation on every restart.
  const env = loadEnv();
  const logsTtlSeconds = ttlSeconds(env.KANSOKU_LOGS_TTL_DAYS);

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
  // `errors_last_seen` doubles as the retention TTL: a fingerprint that
  // stops recurring ages out `KANSOKU_ERRORS_TTL_DAYS` after its last hit,
  // while an active one keeps refreshing `lastSeen` and never expires.
  const errorsTtlSeconds = ttlSeconds(env.KANSOKU_ERRORS_TTL_DAYS);
  await ensureTtlIndex(db, "errors", { lastSeen: -1 }, "errors_last_seen", errorsTtlSeconds);
  const errors = db.collection("errors");
  await errors.createIndex({ service: 1, lastSeen: -1 }, { name: "errors_service_last_seen" });

  // Build-light spans (Phase 8). `_id` is `traceId:spanId`; the waterfall
  // fetches a whole trace's spans by `traceId`. Same retention as `logs`
  // (spans are part of the trace) via a TTL on `startedAt`.
  const spans = db.collection("spans");
  await spans.createIndex({ traceId: 1, startedAt: 1 }, { name: "spans_trace_started" });
  await ensureTtlIndex(db, "spans", { startedAt: -1 }, "spans_started_ttl", logsTtlSeconds);
}
