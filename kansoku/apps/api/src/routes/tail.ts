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

  const filter = makeFilter(parsed);
  const replay = parsed.replay ?? DEFAULT_REPLAY;

  // Subscribe FIRST so no events fall into the gap between the replay
  // snapshot and the live wire. The listener writes into a `pending` buffer
  // until the replay flushes; then we drain `pending` (deduped against the
  // replay set by reference identity — publishLog pushes the same object
  // into both the ring and the emitter) and flip to live mode.
  const pending: StoredLog[] = [];
  let live = false;
  const seen = new Set<StoredLog>();

  const writeEvent = (doc: StoredLog): void => {
    res.write(`data: ${JSON.stringify(doc)}\n\n`);
  };

  const unsubscribe = subscribeLogs((doc) => {
    if (!filter(doc)) return;
    if (live) {
      writeEvent(doc);
    } else {
      pending.push(doc);
    }
  });

  if (!unsubscribe) {
    // Subscriber cap exhausted — reject with 503 rather than letting the
    // EventEmitter silently leak references. The caller (browser
    // EventSource) will auto-reconnect on backoff.
    res.status(503).json({ error: "tail_capacity_exhausted" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  if (replay > 0) {
    for (const doc of recentLogs(filter, replay)) {
      seen.add(doc);
      writeEvent(doc);
    }
  }
  // Drain anything that arrived between subscribe and replay-flush,
  // skipping duplicates already shipped via the replay snapshot.
  for (const doc of pending) {
    if (seen.has(doc)) continue;
    writeEvent(doc);
  }
  pending.length = 0;
  seen.clear();
  live = true;

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeat.unref) heartbeat.unref();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubscribe();
    clearInterval(heartbeat);
  };
  // Listen on both `req` and `res` for close — different Express/proxy
  // combinations fire one or the other when the client disconnects mid-write.
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
});
