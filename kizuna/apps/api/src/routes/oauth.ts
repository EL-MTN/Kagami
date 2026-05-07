import { Router } from "express";
import type { Config } from "../config.js";
import { OAuthToken } from "../db/models/OAuthToken.js";
import { SyncState } from "../db/models/SyncState.js";
import { clearAccessTokenCache } from "../lib/google-auth.js";
import {
  GOOGLE_SCOPES,
  buildAuthUrl,
  exchangeCode,
  makeClient,
  persistRefreshToken,
} from "../lib/google-auth.js";
import { errors } from "../lib/errors.js";
import { makeState, verifyState } from "../lib/oauth-state.js";

export function makeOauthRouter(config: Config): Router {
  const r = Router();

  // Initiate the consent flow. Open at localhost — the trust boundary is the
  // OS user, not a bearer token. The callback is still CSRF-protected.
  r.get("/google/start", (_req, res) => {
    if (!config.KIZUNA_OAUTH_ENCRYPTION_KEY) {
      throw errors.badRequest(
        "KIZUNA_OAUTH_ENCRYPTION_KEY is not set; refresh token storage requires it",
      );
    }
    const client = makeClient(config);
    const state = makeState();
    res.redirect(302, buildAuthUrl(client, state));
  });

  // Google redirects here after consent. Protected by the signed CSRF state.
  r.get("/google/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const error = typeof req.query.error === "string" ? req.query.error : undefined;

    if (error) {
      throw errors.badRequest(`google denied consent: ${error}`);
    }
    if (!code || !state) {
      throw errors.badRequest("missing code or state");
    }
    if (!verifyState(state)) {
      throw errors.unauthorized("invalid or expired state");
    }
    if (!config.KIZUNA_OAUTH_ENCRYPTION_KEY) {
      throw errors.badRequest("KIZUNA_OAUTH_ENCRYPTION_KEY is not set");
    }

    const client = makeClient(config);
    const tokens = await exchangeCode(client, code);
    if (!tokens.refresh_token) {
      throw errors.badRequest(
        "Google did not return a refresh_token (re-consent with prompt=consent required)",
      );
    }
    const scopes = tokens.scope?.split(" ") ?? GOOGLE_SCOPES;
    await persistRefreshToken(tokens.refresh_token, scopes, config.KIZUNA_OAUTH_ENCRYPTION_KEY);

    // A successful re-grant unpauses any worker that was paused on
    // invalid_grant, and invalidates the cached access token.
    await SyncState.updateMany(
      { pausedAt: { $ne: null } },
      { $set: { pausedAt: null, lastError: null } },
    );
    clearAccessTokenCache();

    res
      .status(200)
      .type("text/html")
      .send(
        '<!doctype html><meta charset="utf-8"><title>Granted</title>' +
          '<body style="font-family:system-ui;padding:2rem;color:#18181b">' +
          '<h1 style="font-weight:600">Google access granted ✓</h1>' +
          "<p>You can close this window. Kizuna can now read Gmail and Calendar.</p>" +
          "</body>",
      );
  });

  // Status — returns whether a token is on file.
  r.get("/google/status", async (_req, res) => {
    const doc = await OAuthToken.findOne({
      provider: "google",
      deletedAt: null,
    }).lean();
    if (!doc) {
      res.json({ granted: false });
      return;
    }
    res.json({
      granted: true,
      scopes: (doc.scopes as unknown as string[] | undefined) ?? [],
      grantedAt: doc.grantedAt,
    });
  });

  return r;
}
