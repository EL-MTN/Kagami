import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import { SyncState } from "../db/models/SyncState.js";
import { runCalendarSyncOnce } from "../ingest/calendar.js";
import { runGmailSyncOnce } from "../ingest/gmail.js";

const RunSyncBody = z.object({ force: z.boolean().optional() }).strict();

export function makeSyncRouter(config: Config): Router {
  const r = Router();

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
    const result = await runGmailSyncOnce(config);
    if (body.force && result.status === "paused") {
      await SyncState.updateOne({ provider: "gmail" }, { $set: { pausedAt: null } });
      // force: true also drops Kizuna's cached access token + tells Kao to
      // bypass its own cache (?force=1), so a re-run after re-consenting at
      // Kao actually picks up the fresh token.
      const second = await runGmailSyncOnce(config, { force: true });
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
    const result = await runCalendarSyncOnce(config);
    if (body.force && result.status === "paused") {
      await SyncState.updateOne({ provider: "gcal" }, { $set: { pausedAt: null } });
      // see runGmailSyncOnce above for why we force-vend on the retry.
      const second = await runCalendarSyncOnce(config, { force: true });
      res.json(second);
      return;
    }
    res.json(result);
  });

  return r;
}
