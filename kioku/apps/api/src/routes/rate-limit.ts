import { rateLimit } from "express-rate-limit";
import { z } from "zod";

const WINDOW_MS = 60_000;
const WINDOW_SECONDS = WINDOW_MS / 1000;
const PositiveInt = z.coerce.number().int().positive();

export function parseRateLimitPerMinute(
  envName: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[envName] ?? String(fallback);
  const parsed = PositiveInt.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${envName} must be a positive integer`);
  }
  return parsed.data;
}

export const kiokuRateLimits = {
  windowMs: WINDOW_MS,
  bulkFactsPerMinute: parseRateLimitPerMinute("KIOKU_BULK_RATE_LIMIT_PER_MIN", 10),
  sessionIngestsPerMinute: parseRateLimitPerMinute("KIOKU_SESSION_RATE_LIMIT_PER_MIN", 5),
};

export function createPerMinuteRateLimit(identifier: string, limit: number) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    identifier,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "rate_limited",
      limit,
      window_seconds: WINDOW_SECONDS,
    },
  });
}

export const bulkFactsRateLimit = createPerMinuteRateLimit(
  "kioku-facts-bulk",
  kiokuRateLimits.bulkFactsPerMinute,
);

export const sessionIngestRateLimit = createPerMinuteRateLimit(
  "kioku-sessions",
  kiokuRateLimits.sessionIngestsPerMinute,
);
