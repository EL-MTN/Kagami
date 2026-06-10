import { createLogger, type Logger } from "@kagami/logger";

// Opt into Kansoku ingest when both vars are set. Either being missing leaves
// the logger stdout-only — graceful in dev and during the rollout window
// before Kansoku is reachable. Empty/whitespace strings count as missing so
// `KANSOKU_URL=` in .env doesn't silently disable the shipper, and a
// MALFORMED URL is treated as missing too — the shipper must go stdout-only
// rather than churn on a known-bad endpoint. This mirrors the env spec's
// warn-default on KANSOKU_URL (which logs the warning when the config
// parses); raw process.env is read here because this module initializes
// before the config parse runs.
function validUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return undefined;
  }
}

const kansokuUrl = validUrl(process.env.KANSOKU_URL);
const kansokuToken = process.env.KANSOKU_INGEST_TOKEN?.trim() || undefined;
const kansoku = kansokuUrl && kansokuToken ? { url: kansokuUrl, token: kansokuToken } : undefined;

export const logger: Logger = createLogger({
  service: "kizuna-api",
  component: "api",
  env: process.env.NODE_ENV ?? "development",
  level: process.env.LOG_LEVEL ?? "info",
  kansoku,
});
