import { Router } from "express";
import type { Config } from "../config.js";
import { SyncState } from "../db/models/SyncState.js";
import { clearAccessTokenCache, fetchGrantStatus } from "../lib/kao-client.js";
import { logger } from "../lib/logger.js";
import { errors } from "../lib/errors.js";

// OAuth surface is now a thin proxy in front of Kao — the dashboard's
// contract (`/oauth/google/start` and `/oauth/google/status`) is preserved
// verbatim so no dashboard changes are needed. The Google refresh token, the
// CSRF state, the AES key, and the inline-HTML consent landing page all live
// in Kao now (see `kao/apps/api/src/routes/oauth.ts`).
export function makeOauthRouter(config: Config): Router {
  const r = Router();

  // Bounce the dashboard's "Connect Google" / "Re-authorize" button into
  // Kao's per-grant consent URL. Kao mints the CSRF state and registers a
  // single callback URI in the Google Cloud client — Kizuna doesn't see the
  // OAuth response at all.
  //
  // The browser never returns to Kizuna after consent (Kao owns the success
  // page), so we use the click here as the operator's signal of intent to
  // re-authorize: clear any paused workers and the local access-token cache
  // up front. If the operator abandons the consent flow, the next ingest
  // tick will just re-pause on the same `invalid_grant` — no harm done.
  // This restores the legacy "successful re-consent unsticks workers"
  // behavior, which used to live in the (now deleted) callback handler.
  r.get("/google/start", async (_req, res) => {
    if (!config.KAO_URL || !config.KAO_TOKEN) {
      throw errors.badRequest(
        "Kao is not configured: set KAO_URL and KAO_TOKEN to use Google ingest",
      );
    }
    const { modifiedCount } = await SyncState.updateMany(
      { pausedAt: { $ne: null } },
      { $set: { pausedAt: null, lastError: null } },
    );
    if (modifiedCount > 0) {
      logger.info({ modifiedCount }, "cleared paused ingest workers ahead of re-consent");
    }
    clearAccessTokenCache();
    const base = config.KAO_URL.replace(/\/+$/, "");
    res.redirect(302, `${base}/oauth/kizuna/start`);
  });

  // Re-shape Kao's grant status into the OAuthStatus envelope the dashboard
  // already understands. Kao is consulted with bearer auth; failure or
  // missing config collapses to `{ granted: false }` rather than 5xx — the
  // dashboard's UX in that case is "Connect Google".
  r.get("/google/status", async (_req, res) => {
    const status = await fetchGrantStatus(config);
    res.json(status);
  });

  return r;
}
