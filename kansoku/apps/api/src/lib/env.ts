import { logger } from "../logger.js";

/**
 * Strict positive-integer env-var parsing with a configurable floor. Shared
 * by all KANSOKU_* knobs that take an integer:
 *
 *   - `KANSOKU_LOGS_TTL_DAYS` / `KANSOKU_ERRORS_TTL_DAYS` (via wrapper)
 *   - `KANSOKU_MAX_META_COMBOS`
 *   - `KANSOKU_SPIKE_THRESHOLD` / `KANSOKU_SPIKE_WINDOW_MINUTES` /
 *     `KANSOKU_SPIKE_COOLDOWN_MINUTES`
 *
 * The regex rejects anything other than a run of ASCII digits — `"30days"`
 * (which `parseInt` would silently accept as `30`), `"10x"`, `"+10"`, etc.
 * all fall back to the default with a clear warn so an operator typo is
 * never silently absorbed.
 */
export function resolvePositiveInt(
  envVar: string,
  defaultValue: number,
  opts: { min?: number } = {},
): number {
  const min = opts.min ?? 1;
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    logger.warn(
      { envVar, provided: raw, fallback: defaultValue },
      `${envVar} not a positive integer; using default`,
    );
    return defaultValue;
  }
  const n = Number.parseInt(trimmed, 10);
  if (n < min) {
    logger.warn(
      { envVar, provided: raw, fallback: defaultValue, min },
      `${envVar} must be >= ${min}; using default`,
    );
    return defaultValue;
  }
  return n;
}
