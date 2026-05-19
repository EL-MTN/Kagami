import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { errors } from "./errors.js";

// Constant-time bearer check for the /grants/* vend surface.
//
// This is the one place in the workspace that deliberately does NOT inherit
// the "open at localhost, OS user is the trust boundary" posture. Kao holds
// the single most sensitive credential in Kagami — a Google refresh token
// that, for the `kokoro` grant, can send mail and write the calendar. Anyone
// who can reach this endpoint can act as the user. So a bearer is always
// required, even at localhost, and especially ahead of any non-localhost
// exposure (see the VPS-deployment note in the workspace docs).
//
// SHA-256 both sides before comparing so timingSafeEqual gets equal-length
// inputs regardless of the presented token's length (no length oracle).
export function requireBearer(expectedToken: string): RequestHandler {
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  return (req, _res, next) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !match[1]) {
      next(errors.unauthorized("missing bearer token"));
      return;
    }
    const presentedDigest = createHash("sha256").update(match[1]).digest();
    if (!timingSafeEqual(presentedDigest, expectedDigest)) {
      next(errors.unauthorized("invalid bearer token"));
      return;
    }
    next();
  };
}
