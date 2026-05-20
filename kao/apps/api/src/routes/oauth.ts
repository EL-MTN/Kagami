import { Router } from "express";
import type { Db } from "mongodb";
import type { Config } from "../config.js";
import { isGrantName, scopesFor } from "../grant-registry.js";
import { errors } from "../lib/errors.js";
import {
  buildAuthUrl,
  clearAccessTokenCache,
  exchangeCode,
  makeClient,
  revokeAtGoogle,
} from "../lib/google.js";
import { escapeHtml } from "../lib/html.js";
import { logger } from "../lib/logger.js";
import { makeState, verifyState } from "../lib/oauth-state.js";
import { decrypt, encrypt } from "../lib/encryption.js";
import { getGrant, upsertGrant } from "../storage/grants.js";

const GOOGLE_OAUTH_ERROR_CODES = new Set([
  "access_denied",
  "server_error",
  "invalid_scope",
  "temporarily_unavailable",
  "interaction_required",
]);

function googleOAuthErrorMessage(error: string): string {
  return GOOGLE_OAUTH_ERROR_CODES.has(error)
    ? `google denied consent: ${error}`
    : "google denied consent";
}

// The consent flow is operator-browser-driven, so it is open at localhost
// (like the siblings' OAuth routes). The defense here is the signed CSRF
// state, which also binds the grant — see lib/oauth-state.ts. The sensitive
// surface (token vend) lives under /grants/* behind the bearer.
export function makeOauthRouter(config: Config, db: Db): Router {
  const r = Router();

  // Begin consent for a specific named grant. The grant must be a known
  // registry entry; its scope set is taken from the registry, never from the
  // request, so the consent can't be widened by a crafted URL.
  r.get("/:grant/start", (req, res) => {
    const grant = req.params.grant;
    if (!isGrantName(grant)) {
      throw errors.notFound(`unknown grant '${grant}'`);
    }
    const client = makeClient(config);
    const state = makeState(grant);
    res.redirect(302, buildAuthUrl(client, scopesFor(grant), state));
  });

  // Single shared callback. The grant is recovered from the signed state, not
  // the URL, so only ${KAO_PUBLIC_URL}/oauth/callback is registered in Google.
  r.get("/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const error = typeof req.query.error === "string" ? req.query.error : undefined;

    if (error) {
      throw errors.badRequest(googleOAuthErrorMessage(error));
    }
    if (!code || !state) {
      throw errors.badRequest("missing code or state");
    }
    const verified = verifyState(state);
    if (!verified.ok) {
      throw errors.unauthorized("invalid or expired state");
    }
    const grant = verified.grant;
    if (!isGrantName(grant)) {
      // Signed, but for a grant no longer in the registry.
      throw errors.badRequest(`state names unknown grant '${grant}'`);
    }

    const client = makeClient(config);
    const tokens = await exchangeCode(client, code);
    if (!tokens.refresh_token) {
      throw errors.badRequest(
        "Google did not return a refresh_token (re-consent with prompt=consent required)",
      );
    }
    // Trust the registry scope set for this grant over whatever Google
    // echoes; consent was requested for exactly those.
    const scopes = scopesFor(grant);

    // Re-consent best-effort revokes the PRIOR refresh token at Google.
    // Without this, the old token keeps issuing access tokens against Google's
    // per-client refresh-token limit until it rotates out on its own. The
    // local row is overwritten regardless of whether revocation succeeded.
    const prior = await getGrant(db, grant);
    if (prior?.refreshToken) {
      try {
        const priorRefresh = decrypt(prior.refreshToken, config.KAO_ENCRYPTION_KEY);
        await revokeAtGoogle(config, priorRefresh);
      } catch (err) {
        logger.warn(
          { error: err, grant },
          "could not revoke prior refresh token; proceeding with new grant",
        );
      }
    }

    const enc = encrypt(tokens.refresh_token, config.KAO_ENCRYPTION_KEY);
    await upsertGrant(db, {
      name: grant,
      scopes,
      refreshToken: enc,
      googleSub: null,
    });
    clearAccessTokenCache(grant);

    // Link the operator back to the dashboard (kao.localhost) rather than the
    // API's inline-HTML home — the dashboard is where they started the flow
    // and where Revoke / Probe live. The link target is escaped because the
    // value comes from config and is rendered into HTML.
    const dashboard = config.KAO_DASHBOARD_URL.replace(/\/+$/, "");
    const dashboardGrantHref = `${escapeHtml(dashboard)}/grants/${escapeHtml(grant)}`;
    const dashboardRootHref = escapeHtml(dashboard);
    res
      .status(200)
      .type("text/html")
      .send(
        '<!doctype html><meta charset="utf-8"><title>Granted</title>' +
          '<body style="font-family:system-ui;padding:2rem;color:#18181b">' +
          `<h1 style="font-weight:600">Google access granted for '${escapeHtml(grant)}' ✓</h1>` +
          "<p>You can close this window.</p>" +
          `<p><a href="${dashboardGrantHref}">Back to ${escapeHtml(grant)} in the Kao dashboard</a> · ` +
          `<a href="${dashboardRootHref}">All grants</a></p>` +
          "</body>",
      );
  });

  return r;
}
