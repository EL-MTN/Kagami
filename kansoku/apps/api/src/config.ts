import { logger } from "./logger.js";
import { envSpec, type Config } from "./env.js";

const secretKeys = new Set(envSpec.keys.filter((info) => info.meta.secret).map((info) => info.key));

// Memoize on the raw values of the declared keys, aliases included (the same
// idiom the spike config used pre-migration): hot-path callers (per-ingest
// cardinality and alert checks) skip the re-parse and the re-warn-logging,
// while a test or operator that mutates env mid-flight transparently
// invalidates the cache on the next call.
const watchedKeys = [...envSpec.keyNames, ...Object.keys(envSpec.aliases)];
let cached: Config | undefined;
let cachedKey: string | undefined;

/**
 * Parse the environment through the spec. Kansoku is deliberately fail-open
 * for its tuning knobs: they are defaulted and warn-default, so a bad value
 * warns through the service logger (an operator typo is never silently
 * absorbed) and falls back to the schema default. The one exception is a
 * malformed MONGODB_URI, which throws — a data pointer must never silently
 * redirect the service to the localhost default database.
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
