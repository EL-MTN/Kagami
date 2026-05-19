import { createLogger, type Logger } from "@kagami/logger";

export type { Logger };

// Opt into Kansoku ingest when both vars are set. Either being missing leaves
// the logger stdout-only — graceful in dev and during the rollout window
// before Kansoku is reachable. Empty/whitespace strings count as missing so
// `KANSOKU_URL=` in .env doesn't silently disable the shipper.
const kansokuUrl = process.env.KANSOKU_URL?.trim() || undefined;
const kansokuToken = process.env.KANSOKU_INGEST_TOKEN?.trim() || undefined;
const kansoku = kansokuUrl && kansokuToken ? { url: kansokuUrl, token: kansokuToken } : undefined;

export const logger: Logger = createLogger({
  service: "kao-api",
  component: "api",
  env: process.env.NODE_ENV ?? "development",
  level: process.env.LOG_LEVEL ?? "info",
  kansoku,
});
