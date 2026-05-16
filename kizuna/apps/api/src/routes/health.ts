import { Router } from "express";
import type { DbHandle } from "../db/connect.js";
import { logger } from "../lib/logger.js";

export function healthRouter(db: DbHandle): Router {
  const r = Router();
  r.get("/health", async (_req, res) => {
    const dbOk = await db.ping().catch((err: unknown) => {
      logger.error({ error: err }, "health: db ping failed");
      return false;
    });
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      service: "kizuna-api",
      db: dbOk ? "up" : "down",
      time: new Date().toISOString(),
    });
  });
  return r;
}
