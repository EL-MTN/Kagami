import { Router } from "express";
import type { Config } from "../config.js";
import { fetchGrantStatus } from "../lib/kao-client.js";
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
  r.get("/google/start", (_req, res) => {
    if (!config.KAO_URL || !config.KAO_TOKEN) {
      throw errors.badRequest(
        "Kao is not configured: set KAO_URL and KAO_TOKEN to use Google ingest",
      );
    }
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
