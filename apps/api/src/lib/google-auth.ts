import { OAuth2Client, type Credentials } from "google-auth-library";
import type { Config } from "../config.js";
import { OAuthToken } from "../db/models/OAuthToken.js";
import { decrypt, encrypt } from "./encryption.js";
import { errors } from "./errors.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export function makeClient(config: Config): OAuth2Client {
  if (
    !config.GOOGLE_OAUTH_CLIENT_ID ||
    !config.GOOGLE_OAUTH_CLIENT_SECRET ||
    !config.GOOGLE_OAUTH_REDIRECT_URI
  ) {
    throw errors.badRequest(
      "Google OAuth is not configured: set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI",
    );
  }
  return new OAuth2Client(
    config.GOOGLE_OAUTH_CLIENT_ID,
    config.GOOGLE_OAUTH_CLIENT_SECRET,
    config.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

export function buildAuthUrl(client: OAuth2Client, state: string): string {
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(client: OAuth2Client, code: string): Promise<Credentials> {
  const { tokens } = await client.getToken(code);
  return tokens;
}

export async function persistRefreshToken(
  refreshToken: string,
  scopes: string[],
  envKey: string,
): Promise<void> {
  const enc = encrypt(refreshToken, envKey);
  await OAuthToken.findOneAndUpdate(
    { provider: "google" },
    {
      $set: {
        refreshToken: enc,
        scopes,
        grantedAt: new Date(),
        deletedAt: null,
        source: "concierge",
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
}

// In-memory access-token cache. Spec: not persisted, refreshed on demand,
// cached for the run's lifetime. We treat the API process as a long-running
// "run" and respect the actual token expiry minus a 30s buffer.
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export function clearAccessTokenCache(): void {
  cachedAccessToken = null;
}

export class OAuthError extends Error {
  readonly code: "no_grant" | "invalid_grant" | "refresh_failed";
  constructor(code: "no_grant" | "invalid_grant" | "refresh_failed", message: string) {
    super(message);
    this.code = code;
  }
}

export async function getAccessToken(config: Config): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 30_000) {
    return cachedAccessToken.token;
  }
  const doc = await OAuthToken.findOne({
    provider: "google",
    deletedAt: null,
  }).lean();
  if (!doc || !doc.refreshToken) {
    throw new OAuthError("no_grant", "no Google OAuth grant on file");
  }
  if (!config.KIZUNA_OAUTH_ENCRYPTION_KEY) {
    throw new OAuthError(
      "refresh_failed",
      "KIZUNA_OAUTH_ENCRYPTION_KEY missing — cannot decrypt refresh token",
    );
  }
  const refresh = decrypt(doc.refreshToken as string, config.KIZUNA_OAUTH_ENCRYPTION_KEY);
  const client = makeClient(config);
  client.setCredentials({ refresh_token: refresh });
  try {
    const res = await client.getAccessToken();
    if (!res.token) {
      throw new OAuthError("refresh_failed", "no access token returned");
    }
    const expiry = client.credentials.expiry_date ?? Date.now() + 60_000;
    cachedAccessToken = { token: res.token, expiresAt: expiry };
    return res.token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("invalid_grant")) {
      throw new OAuthError("invalid_grant", "Google rejected the refresh token; re-grant required");
    }
    throw new OAuthError("refresh_failed", msg);
  }
}
