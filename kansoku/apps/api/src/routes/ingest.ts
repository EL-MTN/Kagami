import { Router } from "express";
import { LogBatch, toStoredLog } from "../lib/envelope.js";
import { requireIngestToken } from "../lib/auth.js";
import { publishLogs } from "../lib/log-events.js";
import { insertLogs } from "../storage/logs.js";
import { recordErrors } from "../storage/errors.js";
import { logger } from "../logger.js";

export function createIngestRouter(token: string | undefined): Router {
  const router = Router();

  // Scope the auth gate to POST /logs only. Mounting it via `router.use`
  // ran it for every request routed through this sub-router — and because
  // server.ts mounts this router at `/v1` ahead of the query/tail/errors/
  // services routers, an unset KANSOKU_INGEST_TOKEN took down the entire
  // read surface (live tail, search, errors, services), not just ingest.
  router.post("/logs", requireIngestToken(token), (req, res, next) => {
    try {
      const batch = LogBatch.parse(req.body);
      const docs = batch.map(toStoredLog);

      const dropped = Number(req.header("x-kansoku-dropped") ?? 0);
      if (Number.isFinite(dropped) && dropped > 0) {
        // The header is one count for the whole batch — surface the set of
        // services represented so a multi-service shipper (or a fan-in
        // forwarder) doesn't get attribution stuck on docs[0].
        const services = Array.from(new Set(docs.map((d) => d.meta.service))).sort();
        logger.warn({ dropped, services }, "shipper reported buffer drops");
      }

      // Broadcast first (synchronous, in-process — every connected SSE tail
      // subscriber sees the log immediately). Then fire-and-forget the Mongo
      // write so the shipper's socket closes fast: its local buffer already
      // absorbed network latency, and making it wait on a write would
      // back-pressure the producer needlessly. On Mongo failure we log the
      // miss but the events are already lost to the shipper (it's moved on),
      // so there's no retry to coordinate.
      publishLogs(docs);
      void insertLogs(docs).then(
        (result) => {
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
        },
        (err) => {
          logger.error(
            { err: (err as Error).message, count: docs.length },
            "kansoku ingest write failed",
          );
        },
      );
      // Fingerprint upserts run in parallel with the bulk log write. Same
      // fail-open posture — a failed errors write must never wedge ingest.
      void recordErrors(docs).catch((err) => {
        logger.error(
          { err: (err as Error).message, count: docs.length },
          "kansoku error fingerprint write failed",
        );
      });

      res.status(202).json({ accepted: docs.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
