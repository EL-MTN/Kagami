import "dotenv/config";
import { logger } from "./logger.js";
import { envSpec, type Config } from "./env.js";

export type { Config };

const secretKeys = new Set(envSpec.keys.filter((info) => info.meta.secret).map((info) => info.key));

// Memoize on the raw values of the declared keys — aliases included, so a
// bench mutating the legacy MODEL var in-process invalidates too — letting
// module-scope and per-call readers share one parse (and one round of
// warn-default logging), while a test that mutates env is transparently
// picked up on the next call.
const watchedKeys = [...envSpec.keyNames, ...Object.keys(envSpec.aliases)];
let cached: Config | undefined;
let cachedKey: string | undefined;

/**
 * Parse the environment through the spec. Tuning knobs (PORT, KIOKU_TOP_K,
 * LLM_TIMEOUT_MS) are warn-default and degrade with a logged warning; a
 * mis-set *_KIND, BM25/rate-limit override, or malformed MONGODB_URI (a data
 * pointer must never silently fall back to a different database) throws here
 * at module load, preserving the pre-migration fail-loudly behavior.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const key = JSON.stringify(watchedKeys.map((name) => env[name] ?? null));
  if (cached !== undefined && cachedKey === key) return cached;
  cached = envSpec.parse(env, {
    onWarn: ({ key: envVar, provided, message }) => {
      logger.warn(
        { envVar, provided: secretKeys.has(envVar) ? "<redacted>" : provided, message },
        `${envVar} invalid; using default`,
      );
    },
  });
  cachedKey = key;
  return cached;
}
