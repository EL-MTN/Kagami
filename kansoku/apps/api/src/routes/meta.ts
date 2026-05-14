import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

metaRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

metaRouter.get("/version", async (_req, res, next) => {
  try {
    res.json({ name: "kansoku", version: await readVersion() });
  } catch (err) {
    next(err);
  }
});
