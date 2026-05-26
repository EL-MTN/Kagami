import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import { SyncState } from "../db/models/SyncState.js";
import { runCalendarSyncOnce } from "../ingest/calendar.js";
import { runGmailSyncOnce } from "../ingest/gmail.js";
import { errors } from "../lib/errors.js";

const RunSyncBody = z.object({ force: z.boolean().optional() }).strict();

export function makeSyncRouter(config: Config): Router {
  const r = Router();

  function requireKao(): void {
    if (!config.KAO_URL || !config.KAO_TOKEN) {
      throw errors.badRequest(
        "Kao is not configured: set KAO_URL and KAO_TOKEN to run Google ingest",
      );
    }
  }

  r.get("/sync/gmail/state", async (_req, res) => {
    const doc = await SyncState.findOne({ provider: "gmail" }).lean();
    if (!doc) {
      res.json({
        provider: "gmail",
        historyId: null,
        syncToken: null,
        lastRunAt: null,
        errorCount: 0,
        lastError: null,
        pausedAt: null,
      });
      return;
    }
    res.json({
      provider: "gmail",
      historyId: doc.historyId ?? null,
      syncToken: doc.syncToken ?? null,
      lastRunAt: doc.lastRunAt ?? null,
      errorCount: doc.errorCount ?? 0,
      lastError: doc.lastError ?? null,
      pausedAt: doc.pausedAt ?? null,
    });
  });

  r.post("/sync/gmail/run", async (req, res) => {
    const body = RunSyncBody.parse(req.body ?? {});
    requireKao();
    const result = await runGmailSyncOnce(config);
    if (body.force && result.status === "paused") {
      // Clear both `pausedAt` and `lastError` so a successful second run
      // doesn't leave the dashboard showing a stale "invalid_grant" error.
      // recordSuccessfulRun will overwrite both on success; if the second
      // run fails for a different reason, recordFailedRun captures the new
      // error message rather than masking it with the old one.
      await SyncState.updateOne(
        { provider: "gmail" },
        { $set: { pausedAt: null, lastError: null } },
      );
      const second = await runGmailSyncOnce(config);
      res.json(second);
      return;
    }
    res.json(result);
  });

  r.get("/sync/gcal/state", async (_req, res) => {
    const doc = await SyncState.findOne({ provider: "gcal" }).lean();
    if (!doc) {
      res.json({
        provider: "gcal",
        historyId: null,
        syncToken: null,
        lastRunAt: null,
        errorCount: 0,
        lastError: null,
        pausedAt: null,
      });
      return;
    }
    res.json({
      provider: "gcal",
      historyId: doc.historyId ?? null,
      syncToken: doc.syncToken ?? null,
      lastRunAt: doc.lastRunAt ?? null,
      errorCount: doc.errorCount ?? 0,
      lastError: doc.lastError ?? null,
      pausedAt: doc.pausedAt ?? null,
    });
  });

  r.post("/sync/gcal/run", async (req, res) => {
    const body = RunSyncBody.parse(req.body ?? {});
    requireKao();
    const result = await runCalendarSyncOnce(config);
    if (body.force && result.status === "paused") {
      await SyncState.updateOne(
        { provider: "gcal" },
        { $set: { pausedAt: null, lastError: null } },
      );
      const second = await runCalendarSyncOnce(config);
      res.json(second);
      return;
    }
    res.json(result);
  });

  return r;
}
