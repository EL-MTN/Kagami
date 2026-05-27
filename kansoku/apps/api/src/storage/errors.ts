import type { Collection, Filter } from "mongodb";
import { getDb } from "./mongo.js";
import { fingerprintErrorLog, type ErrorFingerprint } from "../lib/fingerprint.js";
import {
  getSpikeConfig,
  getWebhookUrl,
  postAlert,
  type NewErrorPayload,
  type SpikePayload,
} from "../lib/alerts.js";
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
  // with new docs without a migration. They are NOT projected to API
  // consumers — see `listErrors`.
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

interface FingerprintGroup {
  fp: ErrorFingerprint;
  docs: StoredLog[];
}

/**
 * Fold the error-level lines in `docs` into the errors registry, grouping
 * by fingerprint so each unique error in the batch becomes exactly one
 * upsert.
 *
 * Grouping (vs. one upsert per doc) is load-bearing for two reasons:
 *
 *   1. Same-batch duplicate suppression. Without grouping, a batch with N
 *      logs of a brand-new fingerprint would race N parallel upserts; one
 *      wins (`upsertedCount === 1`, fires the new-error alert) and the
 *      other N-1 fall into `evaluateSpike`, which can cross the threshold
 *      from the same batch — surfacing as a double-fire (new-error AND
 *      spike) for the very first sighting. Grouping eliminates the race.
 *
 *   2. Mongo round-trip economy. A batch of N same-fingerprint errors now
 *      costs one `updateOne` instead of N.
 *
 * `evaluateSpike` is only entered for groups that hit existing fingerprints
 * (the new-error path returns early on an upsert). Spike state lives on
 * each `errors` doc and is rolled atomically per evaluation — see the
 * function-level docstring.
 */
export async function recordErrors(docs: StoredLog[]): Promise<void> {
  const coll = await getErrorsCollection();
  const groups = new Map<string, FingerprintGroup>();

  for (const doc of docs) {
    if (!ERROR_LEVELS.has(doc.meta.level)) continue;
    const fp = fingerprintErrorLog(doc);
    if (!fp) continue;
    const existing = groups.get(fp.fingerprint);
    if (existing) existing.docs.push(doc);
    else groups.set(fp.fingerprint, { fp, docs: [doc] });
  }

  const ops: Promise<void>[] = [];

  for (const group of groups.values()) {
    const { fp, docs: groupDocs } = group;
    const first = groupDocs[0]!;
    const last = groupDocs[groupDocs.length - 1]!;

    const setOnInsert: Partial<ErrorRecord> = {
      service: first.meta.service,
      component: first.meta.component,
      message: fp.message,
      firstSeen: first.ts,
      // Seed the spike-detection window with this group's count, so a
      // fresh-fingerprint burst that arrives after deployment doesn't
      // start its counter pre-charged with old data — and so a future
      // existing-fingerprint eval starts from a known state.
      windowStart: new Date(),
      windowCount: groupDocs.length,
    };
    if (fp.name !== undefined) setOnInsert.name = fp.name;
    if (fp.sampleStack !== undefined) setOnInsert.sampleStack = fp.sampleStack;
    if (first.msg !== undefined) setOnInsert.sampleMsg = first.msg;

    const traceIds: string[] = [];
    for (const d of groupDocs) {
      if (d.traceId) traceIds.push(d.traceId);
    }

    const update: Record<string, unknown> = {
      $setOnInsert: setOnInsert,
      $set: { lastSeen: last.ts },
      $inc: { count: groupDocs.length },
    };
    if (traceIds.length > 0) {
      // Mongo forbids touching the same path in $setOnInsert and $push in
      // one update; $push with $slice creates the array on insert anyway.
      update.$push = { recentTraceIds: { $each: traceIds, $slice: -RECENT_TRACE_CAP } };
    } else {
      setOnInsert.recentTraceIds = [];
    }

    ops.push(
      (async () => {
        const result = await coll.updateOne({ _id: fp.fingerprint }, update, { upsert: true });
        if (result.upsertedCount > 0) {
          // Brand-new fingerprint — fire the new-error alert and skip the
          // spike eval. The seed `windowCount = groupDocs.length` means
          // the next batch's eval starts from the correct baseline.
          void postAlert({
            kind: "kansoku.error.new",
            fingerprint: fp.fingerprint,
            service: first.meta.service,
            component: first.meta.component,
            name: fp.name,
            message: fp.message,
            firstSeen: first.ts.toISOString(),
            ...(last.traceId ? { traceId: last.traceId } : {}),
          } satisfies NewErrorPayload);
          return;
        }
        await evaluateSpike(coll, last, fp, groupDocs.length);
      })(),
    );
  }

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
 * Roll the per-fingerprint fixed-window counter for one group of size
 * `increment` and, if the post-roll count crosses the threshold, fire a
 * spike alert exactly once per cooldown.
 *
 * Short-circuits before any Mongo write when no webhook URL is configured —
 * the alert state has no consumer in that case, so paying for the writes
 * would contradict the "no webhook → no effect" claim in configuration.md.
 *
 * Skips on replay: if the triggering log's `ts` is older than the spike
 * window, the alert is about "errors arriving NOW" and a replay shouldn't
 * trip it, regardless of how many old docs land in the same batch.
 *
 * Two server-side updates back the eval so concurrent ingest stays correct:
 *
 *  1. Aggregation-pipeline `findOneAndUpdate` advances windowStart /
 *     windowCount. A prior `$addFields` stage materializes the reset
 *     predicate as `__reset` so the same boolean expression isn't written
 *     twice (and can't drift); the `$set` stage references `"$__reset"`
 *     and a final `$unset` clears the temp field.
 *
 *  2. If the post-roll count meets the threshold, a conditional `updateOne`
 *     claims the cooldown by setting lastSpikeAlertAt. The filter only
 *     matches when no recent alert exists; we check `matchedCount` (not
 *     `modifiedCount`) so a hypothetical byte-identical post-image can't
 *     be misread as a missed claim.
 */
async function evaluateSpike(
  coll: Collection<ErrorRecord>,
  doc: StoredLog,
  fp: ErrorFingerprint,
  increment: number,
): Promise<void> {
  // Short-circuit when alerts are disabled. Without a consumer the spike
  // state is dead weight; skip the Mongo writes entirely so the no-webhook
  // deployment pays nothing for this feature.
  if (!getWebhookUrl()) return;

  const cfg = getSpikeConfig();
  const now = new Date();
  const windowMs = cfg.windowMinutes * 60_000;
  const cooldownMs = cfg.cooldownMinutes * 60_000;

  // Replay guard. Spike alerts mean "this is happening now"; a batch of
  // old logs (NTP step, shipper buffer drain across a long outage, manual
  // backfill) shouldn't page even though it arrives at wall-clock now.
  if (now.getTime() - doc.ts.getTime() > windowMs) return;

  const windowCutoff = new Date(now.getTime() - windowMs);
  const cooldownCutoff = new Date(now.getTime() - cooldownMs);

  const rolled = await coll.findOneAndUpdate(
    { _id: fp.fingerprint },
    [
      {
        $addFields: {
          __reset: {
            $or: [
              { $eq: [{ $type: "$windowStart" }, "missing"] },
              { $lt: ["$windowStart", windowCutoff] },
            ],
          },
        },
      },
      {
        $set: {
          windowStart: { $cond: ["$__reset", now, "$windowStart"] },
          windowCount: {
            $cond: ["$__reset", increment, { $add: [{ $ifNull: ["$windowCount", 0] }, increment] }],
          },
        },
      },
      { $unset: "__reset" },
    ],
    { returnDocument: "after" },
  );

  if (!rolled || rolled.windowCount === undefined || rolled.windowStart === undefined) return;
  if (rolled.windowCount < cfg.threshold) return;

  // Atomic cooldown claim — the filter matches only if no fresh alert is
  // recorded. Concurrent ingest of the same fingerprint races here; whoever
  // wins fires the alert, the rest see `matchedCount === 0` and skip. We
  // check `matchedCount` rather than `modifiedCount` so the semantic is
  // "filter missed" not "value unchanged".
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
  if (claim.matchedCount === 0) return;

  void postAlert({
    kind: "kansoku.error.spike",
    fingerprint: fp.fingerprint,
    service: doc.meta.service,
    component: doc.meta.component,
    ...(fp.name !== undefined ? { name: fp.name } : {}),
    message: fp.message,
    count: rolled.windowCount,
    windowMinutes: cfg.windowMinutes,
    windowStart: rolled.windowStart.toISOString(),
    // Wall-clock-aligned with windowStart so a downstream consumer doesn't
    // see mixed time domains. The doc's ts is captured separately in the
    // log timeline; the alert is about the moment of detection.
    lastSeen: now.toISOString(),
    ...(doc.traceId ? { traceId: doc.traceId } : {}),
  } satisfies SpikePayload);
}

export interface ListErrorsOptions {
  service?: string;
  limit?: number;
}

// Public-API shape — strips the spike-detection state fields so the
// /v1/errors response (and the dashboard / kansoku-debug CLI that consume
// it) stay byte-identical to their pre-spike-alerts contract.
export type PublicErrorRecord = Omit<
  ErrorRecord,
  "windowStart" | "windowCount" | "lastSpikeAlertAt"
>;

export async function listErrors(opts: ListErrorsOptions = {}): Promise<PublicErrorRecord[]> {
  const coll = await getErrorsCollection();
  const filter: Filter<ErrorRecord> = {};
  if (opts.service) filter.service = opts.service;
  // The projection drops the spike-state fields server-side; the return
  // type's `Omit` reflects that without needing a cast (ErrorRecord is
  // assignable to PublicErrorRecord since the omitted fields were already
  // optional).
  return coll
    .find(filter, { projection: { windowStart: 0, windowCount: 0, lastSpikeAlertAt: 0 } })
    .sort({ lastSeen: -1 })
    .limit(Math.min(opts.limit ?? 100, 500))
    .toArray();
}
