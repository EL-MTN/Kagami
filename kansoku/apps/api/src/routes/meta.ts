import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../storage/mongo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedVersion: string | null = null;
async function readVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
  const raw = await fs.readFile(pkgPath, "utf8");
  cachedVersion = (JSON.parse(raw) as { version: string }).version;
  return cachedVersion;
}

export const metaRouter = Router();

// `/health` — liveness only. Returns 200 as long as the event loop is alive
// and the route handlers are wired. Suitable for Portless's "is the process
// up" probe; should NOT be used for Mongo dependency health.
metaRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// `/ready` — dependency health. Pings Mongo with a `{ ping: 1 }` admin
// command (capped at 2 s). 200 only when the dependency is reachable; 503
// otherwise. Use this from anything that decides whether to send traffic.
const READY_TIMEOUT_MS = 2_000;

metaRouter.get("/ready", async (_req, res) => {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const db = await getDb();
    await Promise.race([
      db.command({ ping: 1 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("mongo ping timeout")), READY_TIMEOUT_MS);
      }),
    ]);
    res.json({ ok: true, mongoLatencyMs: Date.now() - start });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: (err as Error).message,
      mongoLatencyMs: Date.now() - start,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
});

metaRouter.get("/version", async (_req, res, next) => {
  try {
    res.json({ name: "kansoku", version: await readVersion() });
  } catch (err) {
    next(err);
  }
});
