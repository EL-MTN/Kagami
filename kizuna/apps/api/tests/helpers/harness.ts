import { randomBytes } from "node:crypto";
import type { Express } from "express";
import { loadConfig } from "../../src/config.js";
import { connectDb, type DbHandle } from "../../src/db/connect.js";
import "../../src/db/models/Person.js";
import "../../src/db/models/Organization.js";
import "../../src/db/models/Interaction.js";
import "../../src/db/models/Followup.js";
import "../../src/db/models/SyncState.js";
import "../../src/db/models/OAuthToken.js";
import { createApp } from "../../src/server.js";
import { SHARED_MONGO_URI_ENV } from "../global-setup.js";

export type TestHarness = {
  app: Express;
  db: DbHandle;
  uri: string;
  encryptionKey: string;
  stop: () => Promise<void>;
};

export async function startHarness(): Promise<TestHarness> {
  const baseUri = process.env[SHARED_MONGO_URI_ENV];
  if (!baseUri) {
    throw new Error(
      `${SHARED_MONGO_URI_ENV} not set — vitest globalSetup must run before startHarness()`,
    );
  }

  const dbName = `kizuna_test_${randomBytes(6).toString("hex")}`;
  const uri = baseUri.replace(/\/?$/, `/${dbName}`);
  const encryptionKey = randomBytes(32).toString("base64");

  const config = loadConfig({
    MONGODB_URI: uri,
    USER_EMAILS: "test@example.com",
    GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://api.kizuna.localhost/oauth/google/callback",
    KIZUNA_OAUTH_ENCRYPTION_KEY: encryptionKey,
  });

  const db = await connectDb(config.MONGODB_URI);
  const app = createApp({ db, config });

  return {
    app,
    db,
    uri,
    encryptionKey,
    stop: async () => {
      await db.conn.connection.dropDatabase();
      await db.close();
    },
  };
}
