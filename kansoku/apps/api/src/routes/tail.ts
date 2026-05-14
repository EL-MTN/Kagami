import { Router } from "express";
import { z } from "zod";
import { recentLogs, subscribeLogs, type LogFilter } from "../lib/log-events.js";
import type { StoredLog } from "../storage/logs.js";

// SSE for the dashboard's live tail. Connection stays open until the client
// disconnects; a 30-second comment line keeps Portless/proxies from killing
// idle sockets.

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_REPLAY = 50;
const MAX_REPLAY = 200;

const TailQuery = z.object({
  service: z.string().min(1).optional(),
  // Comma-separated list, e.g. "warn,error,fatal".
  level: z.string().min(1).optional(),
  replay: z.coerce.number().int().min(0).max(MAX_REPLAY).optional(),
});

function makeFilter(parsed: z.infer<typeof TailQuery>): LogFilter {
  const wantedLevels = parsed.level
    ? new Set(
        parsed.level
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : undefined;
  return (doc: StoredLog) => {
    if (parsed.service && doc.meta.service !== parsed.service) return false;
    if (wantedLevels && !wantedLevels.has(doc.meta.level)) return false;
    return true;
  };
}

export const tailRouter = Router();

tailRouter.get("/tail", (req, res) => {
  const result = TailQuery.safeParse(req.query);
  if (!result.success) {
    res.status(400).json({ error: "validation_error", issues: result.error.issues });
    return;
  }
  const parsed = result.data;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const filter = makeFilter(parsed);
  const replay = parsed.replay ?? DEFAULT_REPLAY;
  if (replay > 0) {
    for (const doc of recentLogs(filter, replay)) {
      res.write(`data: ${JSON.stringify(doc)}\n\n`);
    }
  }

  const unsubscribe = subscribeLogs((doc) => {
    if (!filter(doc)) return;
    res.write(`data: ${JSON.stringify(doc)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeat.unref) heartbeat.unref();

  const cleanup = (): void => {
    unsubscribe();
    clearInterval(heartbeat);
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
});
