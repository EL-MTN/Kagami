import { randomBytes } from "node:crypto";
import { SHARED_MONGO_URI_ENV } from "../global-setup.ts";

// Point Kioku's lazy mongo singleton at the suite-wide replSet (started in
// globalSetup) and a unique database name for this test file. Must be called
// from beforeAll, before any storage module is imported.
export function setupTestMongo(facet: string): void {
  const baseUri = process.env[SHARED_MONGO_URI_ENV];
  if (!baseUri) {
    throw new Error(`${SHARED_MONGO_URI_ENV} not set — globalSetup must run first`);
  }
  // mongo.ts now reads the DB name from the URI's path. Splice the unique
  // per-facet name into the path while preserving the host:port + query.
  const u = new URL(baseUri);
  u.pathname = `/kioku_${facet}_test_${randomBytes(6).toString("hex")}`;
  process.env.MONGODB_URI = u.toString();
}

// Reset the module-level singleton so a worker that runs another test file
// next picks up that file's env vars on the next getDb() call.
export async function teardownTestMongo(): Promise<void> {
  const { closeMongo } = await import("../../src/storage/mongo.ts");
  await closeMongo();
}
