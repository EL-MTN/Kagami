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
  /** Docs sorted ascending by `ts` so `[0]` is the earliest and `[-1]` the latest. */
  docs: StoredLog[];
}

/**
 * Fold the error-level lines in `docs` into the errors registry, grouping
 * by fingerprint so each unique error in the batch becomes exactly one
 * upsert.
 *
 * Grouping (vs. one upsert per doc) is load-bearing:
 *
 *   1. Same-batch duplicate suppression. Without grouping, a batch with N
 *      logs of a brand-new fingerprint would race N parallel upserts; one
 *      wins (`upsertedCount === 1`, fires the new-error alert) and the
 *      other N-1 fall into `evaluateSpike`, which could cross the
 *      threshold from the same batch.
 *
 *   2. Mongo round-trip economy. A batch of N same-fingerprint errors
 *      costs one update instead of N.
 *
 * The upsert is an aggregation-pipeline update so that:
 *   - `firstSeen` uses `$min` (monotonic even across out-of-order batches)
 *   - `lastSeen` uses `$max` (monotonic; a replay of stale logs cannot
 *     rewind the field — which would otherwise prematurely trip the TTL
 *     index `errors_last_seen` and re-fire new-error after eviction)
 *   - `recentTraceIds` is rebuilt via `$concatArrays` + `$slice`
 *   - Spike-state seeds (`windowStart`, `windowCount`) use `$ifNull` so
 *     they only seed on the very first sighting
 *
 * `evaluateSpike` is only entered when the upsert was NOT an insert
 * (existing fingerprint) AND at least one doc in the group is within the
 * spike window (`now - doc.ts <= windowMs`). Replay batches whose docs
 * are entirely old don't trip spike but still update storage truthfully.
 */
export async function recordErrors(docs: StoredLog[]): Promise<void> {
  // Build groups first — the Mongo handle acquire is unnecessary for
  // batches that contain zero error-level rows (the common case).
  const groups = new Map<string, FingerprintGroup>();
  for (const doc of docs) {
    if (!ERROR_LEVELS.has(doc.meta.level)) continue;
    const fp = fingerprintErrorLog(doc);
    if (!fp) continue;
    const existing = groups.get(fp.fingerprint);
    if (existing) existing.docs.push(doc);
    else groups.set(fp.fingerprint, { fp, docs: [doc] });
  }
  if (groups.size === 0) return;

  // Sort each group's docs ascending by ts so first.ts is the earliest
  // (drives $min firstSeen, new-error firstSeen payload, first.traceId
  // fallback) and last.ts is the latest (drives $max lastSeen and the
  // replay-guard reference).
  for (const group of groups.values()) {
    group.docs.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  const coll = await getErrorsCollection();
  const cfg = getSpikeConfig();
  const windowMs = cfg.windowMinutes * 60_000;
  const now = new Date();
  const windowCutoffMs = now.getTime() - windowMs;
  const ops: Promise<void>[] = [];

  for (const group of groups.values()) {
    const { fp, docs: groupDocs } = group;
    const first = groupDocs[0]!;
    const last = groupDocs[groupDocs.length - 1]!;
    // Only docs whose ts is within the current spike window contribute
    // to the spike counter. Replay-only groups produce inWindowIncrement
    // === 0 → evaluateSpike is skipped, but the storage upsert still
    // records them faithfully.
    const inWindowIncrement = groupDocs.reduce(
      (n, d) => (d.ts.getTime() >= windowCutoffMs ? n + 1 : n),
      0,
    );

    const traceIds: string[] = [];
    // Pick the first available traceId across the (ts-ascending) group
    // so the new-error payload's traceId, when present, corresponds to
    // an actual representative of `firstSeen` rather than a tail-of-batch
    // accident. Falls through to undefined if no doc in the group is
    // traced.
    let firstTraceId: string | undefined;
    for (const d of groupDocs) {
      if (d.traceId) {
        traceIds.push(d.traceId);
        if (firstTraceId === undefined) firstTraceId = d.traceId;
      }
    }

    // Aggregation-pipeline upsert. Every field uses an existing-aware
    // operator ($min/$max/$ifNull/$add/$concatArrays) so the same shape
    // works for both insert and update.
    const setStage: Record<string, unknown> = {
      service: { $ifNull: ["$service", first.meta.service] },
      component: { $ifNull: ["$component", first.meta.component] },
      message: { $ifNull: ["$message", fp.message] },
      firstSeen: { $min: [{ $ifNull: ["$firstSeen", first.ts] }, first.ts] },
      lastSeen: { $max: [{ $ifNull: ["$lastSeen", new Date(0)] }, last.ts] },
      count: { $add: [{ $ifNull: ["$count", 0] }, groupDocs.length] },
      // Seeds: only take effect on insert (existing values are preserved).
      // `windowCount: 0` (not groupDocs.length) so the new-error path
      // doesn't pre-charge the next spike eval with this batch's volume —
      // a phantom backlog that would make the very next live error fire
      // a spike alert with a misleadingly large count.
      windowStart: { $ifNull: ["$windowStart", now] },
      windowCount: { $ifNull: ["$windowCount", 0] },
      recentTraceIds: {
        $slice: [
          { $concatArrays: [{ $ifNull: ["$recentTraceIds", []] }, traceIds] },
          -RECENT_TRACE_CAP,
        ],
      },
    };
    // Optional fields — only conditionally project so a $set with undefined
    // doesn't unset an existing value via BSON's missing-field semantics.
    if (fp.name !== undefined) setStage.name = { $ifNull: ["$name", fp.name] };
    if (fp.sampleStack !== undefined)
      setStage.sampleStack = { $ifNull: ["$sampleStack", fp.sampleStack] };
    if (first.msg !== undefined) setStage.sampleMsg = { $ifNull: ["$sampleMsg", first.msg] };

    ops.push(
      (async () => {
        const result = await coll.updateOne({ _id: fp.fingerprint }, [{ $set: setStage }], {
          upsert: true,
        });
        if (result.upsertedCount > 0) {
          // Brand-new fingerprint — fire the new-error alert. Skip spike
          // eval; the new-error covers this batch.
          void postAlert({
            kind: "kansoku.error.new",
            fingerprint: fp.fingerprint,
            service: first.meta.service,
            component: first.meta.component,
            ...(fp.name !== undefined ? { name: fp.name } : {}),
            message: fp.message,
            firstSeen: first.ts.toISOString(),
            ...(firstTraceId !== undefined ? { traceId: firstTraceId } : {}),
          } satisfies NewErrorPayload);
          return;
        }
        if (inWindowIncrement === 0) return;
        await evaluateSpike(coll, last, fp, inWindowIncrement, cfg, now);
      })(),
    );
  }

  const results = await Promise.allSettled(ops);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    const firstReason: unknown = (failures[0] as PromiseRejectedResult).reason;
    logger.warn(
      {
        failed: failures.length,
        total: ops.length,
        sample: firstReason instanceof Error ? firstReason.message : String(firstReason),
      },
      "kansoku error registry: partial upsert failure",
    );
  }
}

/**
 * Roll the per-fingerprint fixed-window counter for one group of size
 * `increment` (in-window docs only) and, if the post-roll count crosses
 * the threshold, fire a spike alert exactly once per cooldown.
 *
 * Short-circuits before any Mongo write when no webhook URL is configured —
 * the alert state has no consumer in that case.
 *
 * Two server-side updates back the eval:
 *
 *  1. Aggregation-pipeline `findOneAndUpdate` advances windowStart /
 *     windowCount. A prior `$addFields` stage materializes the reset
 *     predicate as `__reset` so the same boolean expression isn't written
 *     twice (and can't drift); the predicate considers BOTH windowStart
 *     and windowCount missing — a legacy partial state shouldn't slip
 *     past the reset.
 *
 *  2. If the post-roll count meets the threshold, a conditional `updateOne`
 *     claims the cooldown by setting lastSpikeAlertAt. The filter only
 *     matches when no recent alert exists; we check `matchedCount` so the
 *     semantic is "filter missed" not "value unchanged".
 */
async function evaluateSpike(
  coll: Collection<ErrorRecord>,
  doc: StoredLog,
  fp: ErrorFingerprint,
  increment: number,
  cfg: ReturnType<typeof getSpikeConfig>,
  now: Date,
): Promise<void> {
  if (!getWebhookUrl()) return;

  const windowMs = cfg.windowMinutes * 60_000;
  const cooldownMs = cfg.cooldownMinutes * 60_000;
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
              { $eq: [{ $type: "$windowCount" }, "missing"] },
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

export type ErrorSortField = "lastSeen" | "firstSeen" | "count";

interface ListErrorsOptions {
  service?: string;
  limit?: number;
  /** Mongo sort field (always descending). Defaults to `lastSeen`. */
  sort?: ErrorSortField;
  /** Lower bound on `lastSeen` — drops fingerprints not seen since this time. */
  since?: Date;
}

// Public-API shape — strips the spike-detection state fields so the
// /v1/errors response (and the dashboard / kansoku-debug CLI that consume
// it) stay byte-identical to their pre-spike-alerts contract.
type PublicErrorRecord = Omit<ErrorRecord, "windowStart" | "windowCount" | "lastSpikeAlertAt">;

export async function listErrors(opts: ListErrorsOptions = {}): Promise<PublicErrorRecord[]> {
  const coll = await getErrorsCollection();
  const filter: Filter<ErrorRecord> = {};
  if (opts.service) filter.service = opts.service;
  if (opts.since) filter.lastSeen = { $gte: opts.since };
  const sortField: ErrorSortField = opts.sort ?? "lastSeen";
  // The projection drops the spike-state fields server-side; the return
  // type's `Omit` reflects that without needing a cast (ErrorRecord is
  // assignable to PublicErrorRecord since the omitted fields were already
  // optional).
  return coll
    .find(filter, { projection: { windowStart: 0, windowCount: 0, lastSpikeAlertAt: 0 } })
    .sort({ [sortField]: -1 })
    .limit(Math.min(opts.limit ?? 100, 500))
    .toArray();
}
