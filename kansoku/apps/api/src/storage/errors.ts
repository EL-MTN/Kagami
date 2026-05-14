import type { Collection, Filter } from "mongodb";
import { getDb } from "./mongo.js";
import { fingerprintErrorLog } from "../lib/fingerprint.js";
import { notifyNewError } from "../lib/alerts.js";
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
      recentTraceIds: [],
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
      update.$push = { recentTraceIds: { $each: [doc.traceId], $slice: -RECENT_TRACE_CAP } };
    }

    // Capture upsertedCount so a brand-new fingerprint fires the alert
    // webhook. Existing rows return upsertedCount: 0, so we don't alert on
    // re-occurrences — Phase 7's webhook is strictly for new-error signal.
    ops.push(
      (async () => {
        const result = await coll.updateOne({ _id: fp.fingerprint }, update, { upsert: true });
        if (result.upsertedCount > 0) {
          await notifyNewError({
            fingerprint: fp.fingerprint,
            service: doc.meta.service,
            component: doc.meta.component,
            name: fp.name,
            message: fp.message,
            firstSeen: doc.ts,
            traceId: doc.traceId,
          });
        }
      })(),
    );
  }

  await Promise.all(ops);
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
