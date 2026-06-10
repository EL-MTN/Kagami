import { logger } from "./logger.js";
import { envSpec, type Config } from "./env.js";

export type { Config };

const secretKeys = new Set(envSpec.keys.filter((info) => info.meta.secret).map((info) => info.key));

// Memoize on the raw values of the declared keys (the same idiom the spike
// config used pre-migration): hot-path callers (per-ingest cardinality and
// alert checks) skip the re-parse and the re-warn-logging, while a test or
// operator that mutates env mid-flight transparently invalidates the cache
// on the next call.
let cached: Config | undefined;
let cachedKey: string | undefined;

/**
 * Parse the environment through the spec. Kansoku is deliberately fail-open:
 * every key is defaulted or optional and carries warn-default, so this never
 * throws — a bad value warns through the service logger (an operator typo is
 * never silently absorbed) and falls back to the schema default.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const key = JSON.stringify(envSpec.keyNames.map((name) => env[name] ?? null));
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
