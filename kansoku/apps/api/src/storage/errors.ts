import type { Collection, Filter } from "mongodb";
import { getDb } from "./mongo.js";
import { fingerprintErrorLog } from "../lib/fingerprint.js";
import { getSpikeConfig, notifyNewError, notifySpike } from "../lib/alerts.js";
import { logger } from "../logger.js";
import type { StoredLog } from "./logs.js";

export interface ErrorRecord {
  _id: string; // fingerprint, 16 hex chars
  service: string;
  component: string;
  name?: string;
  message: string;
  sampleMsg?: string;
  sampleStack?: string;
  firstSeen: Date;
  lastSeen: Date;
  count: number;
  recentTraceIds: string[];
  // Spike-detection state. windowStart + windowCount form a fixed-window
  // counter rolled by `evaluateSpike`; lastSpikeAlertAt gates the cooldown.
  // All three fields are optional so legacy docs (pre-spike-alerts) coexist
  // with new docs without a migration.
  windowStart?: Date;
  windowCount?: number;
  lastSpikeAlertAt?: Date;
}

const RECENT_TRACE_CAP = 20;
const ERROR_LEVELS = new Set(["error", "fatal"]);

async function getErrorsCollection(): Promise<Collection<ErrorRecord>> {
  const db = await getDb();
  return db.collection<ErrorRecord>("errors");
}

/**
 * Fold the error-level lines in `docs` into the errors registry. Each unique
 * fingerprint becomes one document; subsequent occurrences bump `count`,
 * push their `traceId` into a bounded `recentTraceIds` list, and update
 * `lastSeen`. `$setOnInsert` keeps the original sample message/stack so the
 * dashboard always shows the first instance, not the latest churn.
 *
 * Non-error levels and rows that yield no fingerprint signal are skipped.
 */
export async function recordErrors(docs: StoredLog[]): Promise<void> {
  const coll = await getErrorsCollection();
  const ops: Promise<void>[] = [];

  for (const doc of docs) {
    if (!ERROR_LEVELS.has(doc.meta.level)) continue;
    const fp = fingerprintErrorLog(doc);
    if (!fp) continue;

    const setOnInsert: Partial<ErrorRecord> = {
      service: doc.meta.service,
      component: doc.meta.component,
      message: fp.message,
      firstSeen: doc.ts,
      // Seed the spike-detection window so a fresh-fingerprint burst needs
      // exactly `threshold` errors to fire (not `threshold + 1`). On insert
      // this is error #1; the eval path on subsequent errors increments
      // from here.
      windowStart: new Date(),
      windowCount: 1,
    };
    if (fp.name !== undefined) setOnInsert.name = fp.name;
    if (fp.sampleStack !== undefined) setOnInsert.sampleStack = fp.sampleStack;
    if (doc.msg !== undefined) setOnInsert.sampleMsg = doc.msg;

    const update: Record<string, unknown> = {
      $setOnInsert: setOnInsert,
      $set: { lastSeen: doc.ts },
      $inc: { count: 1 },
    };
    if (doc.traceId) {
      // Mongo forbids touching the same path in $setOnInsert and $push in
      // one update ("would create a conflict"). $push with $slice creates
      // the array on insert anyway, so we only seed an empty
      // `recentTraceIds` via $setOnInsert when there's no traceId to push.
      // (Pre-fix this rejected EVERY traced error — the registry silently
      // only ever recorded errors logged outside a trace.)
      update.$push = { recentTraceIds: { $each: [doc.traceId], $slice: -RECENT_TRACE_CAP } };
    } else {
      setOnInsert.recentTraceIds = [];
    }

    // Each upsert is its own task so one failing doc doesn't poison the
    // batch (allSettled below). The alert webhook runs fire-and-forget so
    // a slow / hung webhook can't stall the next batch.
    ops.push(
      (async () => {
        const result = await coll.updateOne({ _id: fp.fingerprint }, update, { upsert: true });
        if (result.upsertedCount > 0) {
          // Fire-and-forget — notifyNewError is itself fail-open with an
          // internal 5 s timeout, but we still detach so a slow webhook
          // can't make `recordErrors` block past Promise.allSettled.
          void notifyNewError({
            fingerprint: fp.fingerprint,
            service: doc.meta.service,
            component: doc.meta.component,
            name: fp.name,
            message: fp.message,
            firstSeen: doc.ts,
            traceId: doc.traceId,
          });
          return;
        }
        // Existing fingerprint — evaluate against the spike threshold.
        await evaluateSpike(coll, doc, fp);
      })(),
    );
  }

  // allSettled so a single upsert failure (e.g. transient Mongo write
  // error on one doc) doesn't poison the rest of the batch.
  const results = await Promise.allSettled(ops);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    logger.warn(
      {
        failed: failures.length,
        total: ops.length,
        sample:
          (failures[0] as PromiseRejectedResult).reason instanceof Error
            ? ((failures[0] as PromiseRejectedResult).reason as Error).message
            : String((failures[0] as PromiseRejectedResult).reason),
      },
      "kansoku error registry: partial upsert failure",
    );
  }
}

/**
 * Roll the per-fingerprint fixed-window counter and, if the post-roll count
 * crosses the threshold, fire a spike alert exactly once per cooldown.
 *
 * Two updates are used so concurrent ingest batches stay correct:
 *
 *  1. Aggregation-pipeline `findOneAndUpdate` advances `windowStart` /
 *     `windowCount`. If the existing window is missing or older than
 *     `now - windowMs`, the window resets to `(now, 1)`; otherwise the
 *     count is incremented. The pipeline form is atomic per-doc, so two
 *     concurrent rollers never lose an increment.
 *
 *  2. If the post-roll count meets the threshold, an `updateOne` claims the
 *     cooldown by setting `lastSpikeAlertAt`. The filter only matches when
 *     no recent alert exists, so only the first concurrent caller fires.
 *
 * Wall-clock `Date.now()` is the reference (not `doc.ts`): the alert is
 * about "errors arriving NOW," and using doc.ts would mis-trigger on a
 * batched replay of old logs.
 */
async function evaluateSpike(
  coll: Collection<ErrorRecord>,
  doc: StoredLog,
  fp: { fingerprint: string; name?: string; message: string },
): Promise<void> {
  const cfg = getSpikeConfig();
  const now = new Date();
  const windowMs = cfg.windowMinutes * 60_000;
  const cooldownMs = cfg.cooldownMinutes * 60_000;
  const windowCutoff = new Date(now.getTime() - windowMs);
  const cooldownCutoff = new Date(now.getTime() - cooldownMs);

  const rolled = await coll.findOneAndUpdate(
    { _id: fp.fingerprint },
    [
      {
        $set: {
          windowStart: {
            $cond: [
              {
                $or: [
                  { $eq: [{ $type: "$windowStart" }, "missing"] },
                  { $lt: ["$windowStart", windowCutoff] },
                ],
              },
              now,
              "$windowStart",
            ],
          },
          windowCount: {
            $cond: [
              {
                $or: [
                  { $eq: [{ $type: "$windowStart" }, "missing"] },
                  { $lt: ["$windowStart", windowCutoff] },
                ],
              },
              1,
              { $add: [{ $ifNull: ["$windowCount", 0] }, 1] },
            ],
          },
        },
      },
    ],
    { returnDocument: "after" },
  );

  if (!rolled || rolled.windowCount === undefined || rolled.windowStart === undefined) return;
  if (rolled.windowCount < cfg.threshold) return;

  // Atomic cooldown claim — the filter matches only if no fresh alert is
  // recorded. Concurrent ingest of the same fingerprint races here; whoever
  // wins fires the alert, the rest see `modifiedCount === 0` and skip.
  const claim = await coll.updateOne(
    {
      _id: fp.fingerprint,
      $or: [
        { lastSpikeAlertAt: { $exists: false } },
        { lastSpikeAlertAt: { $lt: cooldownCutoff } },
      ],
    },
    { $set: { lastSpikeAlertAt: now } },
  );
  if (claim.modifiedCount === 0) return;

  void notifySpike({
    fingerprint: fp.fingerprint,
    service: doc.meta.service,
    component: doc.meta.component,
    name: fp.name,
    message: fp.message,
    count: rolled.windowCount,
    windowMinutes: cfg.windowMinutes,
    windowStart: rolled.windowStart,
    lastSeen: rolled.lastSeen,
    traceId: doc.traceId,
  });
}

export interface ListErrorsOptions {
  service?: string;
  limit?: number;
}

export async function listErrors(opts: ListErrorsOptions = {}): Promise<ErrorRecord[]> {
  const coll = await getErrorsCollection();
  const filter: Filter<ErrorRecord> = {};
  if (opts.service) filter.service = opts.service;
  return coll
    .find(filter)
    .sort({ lastSeen: -1 })
    .limit(Math.min(opts.limit ?? 100, 500))
    .toArray();
}
