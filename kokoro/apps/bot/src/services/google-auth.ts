import { google } from "googleapis";
import { getAccessToken } from "./kao-client";

// Kokoro no longer owns Google OAuth client credentials or a refresh token.
// Access tokens are vended by the Kao identity service (the workspace's
// shared OAuth grant store); this module just wraps that vend in the
// `OAuth2Client` shape that the `googleapis` library expects.
//
// Async: the underlying network call to Kao is async (Kao's in-process
// cache short-circuits most calls anyway). gmail.ts / google-calendar.ts
// `await` this and pass the result as `auth` to `google.gmail(...)` /
// `google.calendar(...)`.
//
// The OAuth2Client is constructed fresh per call — it's cheap, and avoiding
// a singleton means we never serve a stale access token after Kao re-issues.
export async function getGoogleAuth(): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const { accessToken } = await getAccessToken();
  const client = new google.auth.OAuth2();
  client.setCredentials({ access_token: accessToken });
  return client;
}
