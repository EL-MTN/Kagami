import { timingSafeEqual } from "node:crypto";
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

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function readKey(req: import("express").Request): string | undefined {
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const q = req.query.key;
  if (typeof q === "string") return q;
  return undefined;
}

export function makeOauthRouter(config: Config): Router {
  const r = Router();

  // Initiate the consent flow. Accepts the API key via Authorization header
  // or `?key=` query param so the dashboard can render a plain <a href>.
  r.get("/google/start", (req, res) => {
    const key = readKey(req);
    if (!key || !constantTimeMatch(key, config.KIZUNA_API_KEY)) {
      throw errors.unauthorized("invalid api key");
    }
    if (!config.KIZUNA_OAUTH_ENCRYPTION_KEY) {
      throw errors.badRequest(
        "KIZUNA_OAUTH_ENCRYPTION_KEY is not set; refresh token storage requires it",
      );
    }
    const client = makeClient(config);
    const state = makeState(config.KIZUNA_API_KEY);
    res.redirect(302, buildAuthUrl(client, state));
  });

  // Google redirects here after consent. No bearer auth — protected by
  // CSRF state signed with the API key.
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
    if (!verifyState(config.KIZUNA_API_KEY, state)) {
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

  // Status — bearer-gated. Returns whether a token is on file.
  r.get("/google/status", async (req, res) => {
    const key = readKey(req);
    if (!key || !constantTimeMatch(key, config.KIZUNA_API_KEY)) {
      throw errors.unauthorized("invalid api key");
    }
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
