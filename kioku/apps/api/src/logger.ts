import { createLogger } from "@kagami/logger";

// Opt into Kansoku ingest when both vars are set. Either being missing leaves
// the logger stdout-only — graceful in dev and during the rollout window
// before Kansoku is reachable.
const kansokuUrl = process.env.KANSOKU_URL;
const kansokuToken = process.env.KANSOKU_INGEST_TOKEN;
const kansoku = kansokuUrl && kansokuToken ? { url: kansokuUrl, token: kansokuToken } : undefined;

export const logger = createLogger({
  service: "kioku-api",
  component: "api",
  env: process.env.NODE_ENV ?? "development",
  level: process.env.LOG_LEVEL ?? "info",
  kansoku,
});
