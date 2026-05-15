import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const AUTH_HEADER = "x-kansoku-auth";

function tokensMatch(provided: string, expected: string): boolean {
  // Build buffers first so the comparison is byte-length-based. JS string
  // `.length` counts UTF-16 code units, not bytes — a multibyte UTF-8 token
  // of equal char length but different byte length would slip past a
  // length check into `timingSafeEqual`, which throws on mismatched byte
  // length and would surface as a 500 (with leaky semantics) instead of
  // the intended 401.
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
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
