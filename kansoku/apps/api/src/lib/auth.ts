import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const AUTH_HEADER = "x-kansoku-auth";

function tokensMatch(provided: string, expected: string): boolean {
  // Constant-time compare. Reject early if lengths differ — timingSafeEqual
  // throws on length mismatch, and the early-exit is itself information,
  // but that's fine: the token length is fixed per Kagami install, so a
  // would-be attacker already needs to know the length to test anything.
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return timingSafeEqual(a, b);
}

/**
 * Middleware factory. Compares `x-kansoku-auth` against the configured token
 * in constant time. If `expected` is empty/undefined, every request is
 * rejected — fail-closed by default, so a misconfigured server can't accept
 * unauthenticated ingest.
 */
export function requireIngestToken(expected: string | undefined): RequestHandler {
  return (req, res, next) => {
    if (!expected) {
      res.status(503).json({ error: "ingest_not_configured" });
      return;
    }
    const provided = req.header(AUTH_HEADER);
    if (!provided || !tokensMatch(provided, expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
