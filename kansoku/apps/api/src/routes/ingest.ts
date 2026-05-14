import { Router } from "express";
import { LogBatch, toStoredLog } from "../lib/envelope.js";
import { requireIngestToken } from "../lib/auth.js";
import { insertLogs } from "../storage/logs.js";
import { logger } from "../logger.js";

export function createIngestRouter(token: string | undefined): Router {
  const router = Router();
  router.use(requireIngestToken(token));

  router.post("/logs", (req, res, next) => {
    try {
      const batch = LogBatch.parse(req.body);
      const docs = batch.map(toStoredLog);

      const dropped = Number(req.header("x-kansoku-dropped") ?? 0);
      if (Number.isFinite(dropped) && dropped > 0) {
        logger.warn({ dropped, service: docs[0]?.meta.service }, "shipper reported buffer drops");
      }

      // Fire-and-forget write: ack the shipper immediately so its socket
      // closes before Mongo round-trips. The shipper's local buffer already
      // absorbed network latency; making it wait on a write here would
      // back-pressure the producer needlessly. On Mongo failure we log the
      // miss but the events are already lost to the shipper (it's moved on),
      // so there's no retry to coordinate.
      void insertLogs(docs).catch((err) => {
        logger.error(
          { err: (err as Error).message, count: docs.length },
          "kansoku ingest write failed",
        );
      });

      res.status(202).json({ accepted: docs.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
