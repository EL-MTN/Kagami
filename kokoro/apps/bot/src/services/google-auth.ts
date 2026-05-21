import { google } from "googleapis";
import { clearAccessTokenCache, getAccessToken } from "./kao-client";

// Kokoro no longer owns Google OAuth client credentials or a refresh token.
// Access tokens are vended by the Kao identity service (the workspace's
// shared OAuth grant store); this module wraps that vend in the
// `OAuth2Client` shape the `googleapis` library expects, and adds a
// self-healing retry for the case where Google revokes Kokoro's access
// mid-cache-window (operator pulled the plug at Google, token rotated).

async function getGoogleAuth(
  options: { force?: boolean } = {},
): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const { accessToken } = await getAccessToken(options);
  const client = new google.auth.OAuth2();
  client.setCredentials({ access_token: accessToken });
  return client;
}

// Heuristic: googleapis throws GaxiosError on HTTP failures; the HTTP status
// lives at `err.status` or `err.response.status`. `err.code` carries Node
// errno strings (ECONNRESET, ETIMEDOUT) — irrelevant for auth-failure
// detection. 401/403 are the only auth-token-rejection cases worth
// invalidating for.
function isAccessTokenRejection(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: number; response?: { status?: number } };
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.response?.status === "number"
        ? e.response.status
        : undefined;
  return status === 401 || status === 403;
}

/**
 * Run a Google API call with a self-healing access token. If Google rejects
 * the cached token (401/403), drop the kao-client cache AND have Kao bypass
 * ITS cache too (`force: true` → `?force=1` on /grants/kokoro/token), so the
 * retry actually goes back to Google instead of being handed the same dead
 * token from Kao's local store. Retry exactly once.
 *
 * Without the `force` hop, clearing only Kokoro's local cache would still
 * leave Kao's 30 s-buffer cache to re-vend the stale token for up to the
 * remainder of its lifetime — defeating the purpose of the retry. See
 * kao/apps/api/src/lib/google.ts:refreshAccessToken's `force` semantics and
 * kao/apps/api/src/routes/grants.ts (the `?force=1` query parameter).
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
    const fresh = await getGoogleAuth({ force: true });
    return op(fresh);
  }
}
