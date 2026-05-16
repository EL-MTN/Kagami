import { Router } from "express";
import { LogBatch, toStoredLog } from "../lib/envelope.js";
import { requireIngestToken } from "../lib/auth.js";
import { publishLogs } from "../lib/log-events.js";
import { insertLogs, type InsertLogsResult } from "../storage/logs.js";
import { recordErrors } from "../storage/errors.js";
import { logger } from "../logger.js";
import type { StoredLog } from "../storage/logs.js";

// Write-then-ack bounded retry. `insertLogs` only *throws* on a
// connection/total failure (a Mongo outage); per-doc validation rejections
// come back in the result and are deliberately NOT retried — a structurally
// bad doc won't write on resend, and re-NAKing it would poison the shipper's
// queue forever. The whole retry budget is kept well under the shipper's
// 10 s request timeout so we still ack within its window when Mongo is up.
const MAX_WRITE_ATTEMPTS = 3;
const BASE_WRITE_BACKOFF_MS = 50;
const MAX_WRITE_BACKOFF_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function insertWithRetry(docs: StoredLog[]): Promise<InsertLogsResult> {
  let attempt = 0;
  for (;;) {
    try {
      return await insertLogs(docs);
    } catch (err) {
      attempt += 1;
      if (attempt >= MAX_WRITE_ATTEMPTS) throw err;
      // Full jitter so a fleet of shippers reconnecting after a Mongo blip
      // doesn't resynchronize onto the same retry tick.
      const ceil = Math.min(BASE_WRITE_BACKOFF_MS * 2 ** (attempt - 1), MAX_WRITE_BACKOFF_MS);
      await sleep(Math.floor(Math.random() * ceil) + 1);
    }
  }
}

export function createIngestRouter(token: string | undefined): Router {
  const router = Router();

  // Scope the auth gate to POST /logs only. Mounting it via `router.use`
  // ran it for every request routed through this sub-router — and because
  // server.ts mounts this router at `/v1` ahead of the query/tail/errors/
  // services routers, an unset KANSOKU_INGEST_TOKEN took down the entire
  // read surface (live tail, search, errors, services), not just ingest.
  router.post("/logs", requireIngestToken(token), async (req, res, next) => {
    let docs: StoredLog[];
    try {
      const batch = LogBatch.parse(req.body);
      docs = batch.map(toStoredLog);
    } catch (err) {
      // Malformed batch → 400 via the error middleware. Retrying won't help,
      // so this never reaches the durability path below.
      next(err);
      return;
    }

    const dropped = Number(req.header("x-kansoku-dropped") ?? 0);
    if (Number.isFinite(dropped) && dropped > 0) {
      // The header is one count for the whole batch — surface the set of
      // services represented so a multi-service shipper (or a fan-in
      // forwarder) doesn't get attribution stuck on docs[0].
      const services = Array.from(new Set(docs.map((d) => d.meta.service))).sort();
      logger.warn({ dropped, services }, "shipper reported buffer drops");
    }

    // Broadcast first (synchronous, in-process — every connected SSE tail
    // subscriber sees the log immediately, independent of the durable write).
    publishLogs(docs);

    // Fingerprint upserts are derived and idempotent on a shipper resend, so
    // they stay fire-and-forget — a slow/hung errors upsert must never delay
    // the ack or wedge ingest.
    void recordErrors(docs).catch((err) => {
      logger.error(
        { error: (err as Error).message, count: docs.length },
        "kansoku error fingerprint write failed",
      );
    });

    // Write-then-ack: only acknowledge once the batch is durably written.
    // On persistent failure respond 503 so the shipper treats it as a
    // failure and requeues the batch into its bounded local buffer (the
    // producer-side durability queue), retrying with backoff — instead of
    // the old fire-and-forget path that lost the whole batch silently
    // during a Mongo outage.
    try {
      const result = await insertWithRetry(docs);
      if (result.failedCount > 0) {
        logger.warn(
          {
            inserted: result.insertedCount,
            failed: result.failedCount,
            sampleErrors: result.sampleErrors,
          },
          "kansoku ingest partial write",
        );
      }
      res.status(202).json({ accepted: result.insertedCount });
    } catch (err) {
      logger.error(
        { error: (err as Error).message, count: docs.length },
        "kansoku ingest write failed; shipper will requeue",
      );
      res.status(503).json({ error: "ingest_write_failed" });
    }
  });

  return router;
}
