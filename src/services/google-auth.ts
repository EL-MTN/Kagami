import { google } from "googleapis";
import { config } from "../config.js";

let client: InstanceType<typeof google.auth.OAuth2> | null = null;

export function getGoogleAuth(): InstanceType<typeof google.auth.OAuth2> {
  if (client) return client;

  if (!config.GOOGLE_OAUTH_CLIENT_ID || !config.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error("Google OAuth credentials not configured");
  }

  client = new google.auth.OAuth2(config.GOOGLE_OAUTH_CLIENT_ID, config.GOOGLE_OAUTH_CLIENT_SECRET);

  client.setCredentials({ refresh_token: config.GOOGLE_OAUTH_REFRESH_TOKEN });

  return client;
}
