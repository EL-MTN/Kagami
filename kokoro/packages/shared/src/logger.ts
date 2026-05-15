import { createLogger } from "@kagami/logger";
import { config } from "./config";

// Opt into Kansoku ingest when both vars are set. Either being missing leaves
// the logger stdout-only — graceful in dev and during outages.
// `imageData` redaction is now in `@kagami/logger`'s `DEFAULT_REDACT_PATHS`
// (replaces base64 with "[base64 omitted, ~Nb]") so no per-service formatter
// is needed.
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
