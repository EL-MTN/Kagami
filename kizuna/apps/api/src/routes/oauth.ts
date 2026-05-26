import { Router } from "express";
import type { Config } from "../config.js";
import { SyncState } from "../db/models/SyncState.js";
import { clearAccessTokenCache, fetchGrantStatus } from "../lib/kao-client.js";
import { logger } from "../lib/logger.js";
import { errors } from "../lib/errors.js";

// OAuth surface is now a thin proxy in front of Kao — the dashboard's
// contract (`/oauth/google/start` and `/oauth/google/status`) is preserved
// in spirit so no dashboard data flow changes are needed. The Google
// refresh token, the CSRF state, the AES key, and the inline-HTML consent
// landing page all live in Kao now (see `kao/apps/api/src/routes/oauth.ts`).
//
// `/oauth/google/start` is intentionally a POST because it mutates SyncState
// (clears pausedAt/errorCount on paused workers) and the access-token cache
// before redirecting. A GET endpoint with side effects is reachable by
// browser preloaders, link unfurlers, and stray <img src> tags — any of
// which would silently destroy paused-worker diagnostic state. The dashboard
// renders this as a <form method="post"> so the operator experience is
// unchanged.
export function makeOauthRouter(config: Config): Router {
  const r = Router();

  // Allow-list of Origins that may POST to /oauth/google/start. Default is
  // the Portless dashboard origin (`https://kizuna.localhost`); operators on
  // a different dashboard origin extend the list via the comma-separated
  // KIZUNA_DASHBOARD_ORIGIN env var. The previous hardcoded
  // `https://api.kizuna.localhost` entry was dropped — the API never hosts
  // a form, so a request claiming that as its Origin is never legitimate.
  //
  // Programmatic callers (curl, supertest, the dashboard's server-side
  // fetch path) typically don't send an Origin header at all, OR send an
  // empty one in some browsers / no-referrer policies. Both cases are
  // allowed: OS-user-trusted on the localhost-only deployment, and an
  // empty Origin is indistinguishable in intent from a missing one. The
  // check rejects requests that DO send an Origin which isn't on the list
  // — a malicious cross-origin tab can't omit Origin from a form POST in
  // any current browser.
  const allowedOrigins = new Set<string>(["https://kizuna.localhost"]);
  for (const extra of config.KIZUNA_DASHBOARD_ORIGIN) allowedOrigins.add(extra);

  r.post("/google/start", async (req, res) => {
    if (!config.KAO_URL || !config.KAO_TOKEN) {
      throw errors.badRequest(
        "Kao is not configured: set KAO_URL and KAO_TOKEN to use Google ingest",
      );
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && !allowedOrigins.has(origin)) {
      throw errors.unauthorized(`origin '${origin}' not allowed`);
    }
    // Operator is about to re-consent at Kao. Reset the operator-visible
    // failure counters on paused workers and drop the local access-token
    // cache so the next ingest tick uses the fresh refresh token Kao stores.
    // `lastError` is intentionally NOT cleared here — recordSuccessfulRun
    // will clear it on the next successful tick (recordIdleRun on no_grant),
    // and recordFailedRun will overwrite it on a fresh failure.
    //
    // If the DB write fails (transient Mongo issue), log it but proceed
    // with the redirect — the next ingest tick will simply re-pause on the
    // same invalid_grant if Kao consent doesn't take. Blocking the redirect
    // on a Mongo blip would strand the operator with a generic 500 and no
    // way to even attempt re-consent.
    //
    // Match docs via `pausedAt: { $type: "date" }` rather than `$ne: null`
    // — the latter also matches docs where the field is missing entirely,
    // which would cause this cleanup to mutate workers that were never
    // paused. Schema default is `null`, so Mongoose-created docs would
    // never trigger that path, but a raw `insertOne` from a script could.
    try {
      const { modifiedCount } = await SyncState.updateMany(
        { pausedAt: { $type: "date" } },
        { $set: { pausedAt: null, errorCount: 0 } },
      );
      if (modifiedCount > 0) {
        logger.info({ modifiedCount }, "cleared paused ingest workers ahead of re-consent");
      }
    } catch (err) {
      logger.warn({ error: err }, "could not reset paused workers before re-consent");
    }
    clearAccessTokenCache();
    const base = config.KAO_URL.replace(/\/+$/, "");
    // 303 See Other is the HTTP-correct status for "POST that should be
    // followed by a GET to the redirect URL"; browsers follow this with a
    // GET to Kao's per-grant consent endpoint.
    res.redirect(303, `${base}/oauth/kizuna/start`);
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
