import { google } from "googleapis";
import { clearAccessTokenCache, getAccessToken } from "./kao-client";

// Kokoro no longer owns Google OAuth client credentials or a refresh token.
// Access tokens are vended by the Kao identity service (the workspace's
// shared OAuth grant store); this module wraps that vend in the
// `OAuth2Client` shape the `googleapis` library expects, and adds a
// self-healing retry for the case where Google revokes Kokoro's access
// mid-cache-window (operator pulled the plug at Google, token rotated).

export async function getGoogleAuth(): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const { accessToken } = await getAccessToken();
  const client = new google.auth.OAuth2();
  client.setCredentials({ access_token: accessToken });
  return client;
}

// Heuristic: googleapis throws GaxiosError on HTTP failures; status lives at
// either err.code (varies by version: number or string) or err.response.status.
// 401/403 are the only auth-token-rejection cases worth invalidating for.
function isAccessTokenRejection(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: number | string;
    status?: number;
    response?: { status?: number };
  };
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.response?.status === "number"
        ? e.response.status
        : typeof e.code === "number"
          ? e.code
          : typeof e.code === "string" && /^[0-9]+$/.test(e.code)
            ? Number(e.code)
            : undefined;
  return status === 401 || status === 403;
}

/**
 * Run a Google API call with a self-healing access token. If Google rejects
 * the cached token (401/403), drop the kao-client cache (so the next
 * getGoogleAuth re-fetches from Kao) and retry the operation exactly once.
 *
 * Without this, a cached access token that Google revokes server-side stays
 * pinned in-process until its local `expiresAt` lapses — every Gmail/Calendar
 * call fails in the interim. With it, the next call recovers automatically.
 *
 * Retry is bounded to one attempt: if Kao itself can't get a new token from
 * Google (refresh rejected → 409 invalid_grant), the second attempt's
 * getAccessToken throws KaoNoGrantError, which propagates as expected and
 * the operator gets the re-consent hint.
 */
export async function withFreshAuth<T>(
  op: (auth: InstanceType<typeof google.auth.OAuth2>) => Promise<T>,
): Promise<T> {
  const auth = await getGoogleAuth();
  try {
    return await op(auth);
  } catch (err) {
    if (!isAccessTokenRejection(err)) throw err;
    clearAccessTokenCache();
    const fresh = await getGoogleAuth();
    return op(fresh);
  }
}
