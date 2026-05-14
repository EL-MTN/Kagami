import { createLogger } from "@kagami/logger";
import { config } from "./config";

// Opt into Kansoku ingest when both vars are set. Either being missing leaves
// the logger stdout-only — graceful in dev and during the rollout window
// before Kansoku is reachable.
// The custom imageData formatter that used to live here is now redundant:
// @kagami/logger's DEFAULT_REDACT_PATHS covers `imageData` (and one level of
// nesting) and replaces base64 with "[base64 omitted, ~Nb]" — so the payload
// size stays observable without the bytes.
const kansokuUrl = config.KANSOKU_URL;
const kansokuToken = config.KANSOKU_INGEST_TOKEN;
const kansoku = kansokuUrl && kansokuToken ? { url: kansokuUrl, token: kansokuToken } : undefined;

export const logger = createLogger({
  service: "kokoro-bot",
  component: "bot",
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
  kansoku,
});
