import { OAuth2Client, type Credentials } from "google-auth-library";
import { callbackUrl, type Config } from "../config.js";
import { logger } from "./logger.js";

// OAuth mechanics, modeled on Kizuna's apps/api/src/lib/google-auth.ts but
// multi-grant: one OAuth2Client construction helper, and a per-grant
// access-token cache (Kizuna kept a single process-global slot because it has
// exactly one grant; Kao keys by grant name).

export function makeClient(config: Config): OAuth2Client {
  return new OAuth2Client(
    config.GOOGLE_OAUTH_CLIENT_ID,
    config.GOOGLE_OAUTH_CLIENT_SECRET,
    callbackUrl(config),
  );
}

export function buildAuthUrl(client: OAuth2Client, scopes: string[], state: string): string {
  return client.generateAuthUrl({
    access_type: "offline",
    // Non-negotiable: Google only returns a refresh_token on a fresh consent.
    // Without it a re-grant may yield only an access token and the callback
    // rejects with "no refresh_token".
    prompt: "consent",
    scope: scopes,
    state,
    include_granted_scopes: false,
  });
}

export async function exchangeCode(client: OAuth2Client, code: string): Promise<Credentials> {
  const { tokens } = await client.getToken(code);
  return tokens;
}

export class OAuthError extends Error {
  readonly code: "no_grant" | "invalid_grant" | "refresh_failed";
  constructor(code: "no_grant" | "invalid_grant" | "refresh_failed", message: string) {
    super(message);
    this.code = code;
  }
}

// Per-grant in-process access-token cache. Not persisted; refreshed on demand;
// honor the real expiry minus a 30s buffer (Kizuna's policy). Cleared on a
// re-consent or revoke of that grant so the change takes effect immediately.
const cache = new Map<string, { token: string; expiresAt: number }>();
// In-flight de-dup: N concurrent /grants/:grant/token requests on a cold
// cache must collapse into ONE Google refresh, not N parallel ones (each
// constructing its own OAuth2Client and racing to win the cache write).
const inflight = new Map<string, Promise<VendedToken>>();

// Clear BOTH cache and inflight for this grant. Clearing only `cache` would
// leave a stale inflight (started before the clear, e.g. before a re-consent
// or before Google revoked the token) to overwrite `cache` with a stale
// result the moment it resolves — partially defeating the clear.
export function clearAccessTokenCache(grant: string): void {
  cache.delete(grant);
  inflight.delete(grant);
}

export interface VendedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Vend an access token for the grant.
 *
 * `force: true` bypasses both the cache and any existing inflight Promise and
 * starts a brand-new Google refresh. The force path is the workspace's only
 * self-heal route: when a consumer (e.g. Kokoro) sees Google reject the
 * vended access token with 401/403, retrying with the same token won't help —
 * Kao would just hand back its cached value. `force=1` makes Kao actually
 * round-trip to Google. Concurrent forced calls still dedup to a single
 * Google refresh via the inflight slot, but they will NOT join an
 * already-in-flight non-force refresh (which might be using a stale token).
 */
export async function refreshAccessToken(
  config: Config,
  grant: string,
  refreshToken: string,
  options: { force?: boolean } = {},
): Promise<VendedToken> {
  if (!options.force) {
    const hit = cache.get(grant);
    if (hit && hit.expiresAt > Date.now() + 30_000) {
      return { accessToken: hit.token, expiresAt: hit.expiresAt };
    }
    const existing = inflight.get(grant);
    if (existing) return existing;
  } else {
    // Force: evict cache + any non-force inflight so this caller starts fresh
    // and other callers arriving during this refresh join THIS Google call,
    // not a stale predecessor.
    cache.delete(grant);
    inflight.delete(grant);
  }

  const p = doRefresh(config, grant, refreshToken).finally(() => {
    inflight.delete(grant);
  });
  inflight.set(grant, p);
  return p;
}

async function doRefresh(
  config: Config,
  grant: string,
  refreshToken: string,
): Promise<VendedToken> {
  const client = makeClient(config);
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const res = await client.getAccessToken();
    if (!res.token) {
      throw new OAuthError("refresh_failed", "no access token returned");
    }
    const expiresAt = client.credentials.expiry_date ?? Date.now() + 60_000;
    cache.set(grant, { token: res.token, expiresAt });
    return { accessToken: res.token, expiresAt };
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("invalid_grant")) {
      logger.error({ error: err, grant }, "google refresh rejected — re-consent required");
      throw new OAuthError(
        "invalid_grant",
        "Google rejected the refresh token; re-consent required",
      );
    }
    logger.error({ error: err, grant }, "google token refresh failed");
    throw new OAuthError("refresh_failed", msg);
  }
}

// Best-effort revocation at Google. Failure is logged, not fatal — the local
// row is dropped regardless so the credential stops being vendable.
export async function revokeAtGoogle(config: Config, refreshToken: string): Promise<void> {
  try {
    const client = makeClient(config);
    await client.revokeToken(refreshToken);
  } catch (err) {
    logger.warn({ error: err }, "google token revocation failed (local row dropped anyway)");
  }
}
