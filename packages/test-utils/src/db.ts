import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll } from "vitest";
import { SHARED_MONGO_URI_ENV } from "./global-setup";

interface TestDbHandle {
  uri: () => string;
}

interface TestDbOptions {
  /**
   * Run `syncIndexes` against every registered model after connecting.
   * Defaults to `true`. Tests that don't exercise unique-index/duplicate-key
   * behavior can pass `syncIndexes: false` to skip the cost (~30–80 ms per
   * file at parallel-worker contention peaks; nothing measurable when run
   * in isolation, but real wall-clock impact across the full 21-file matrix).
   */
  syncIndexes?: boolean;
}

export function withTestDb(options: TestDbOptions = {}): TestDbHandle {
  const { syncIndexes = true } = options;
  let connectionUri: string | undefined;

  beforeAll(async () => {
    const baseUri = process.env[SHARED_MONGO_URI_ENV];
    if (!baseUri) {
      throw new Error(`withTestDb: ${SHARED_MONGO_URI_ENV} is not set; globalSetup must run`);
    }
    const dbName = `test_${randomUUID().replace(/-/g, "")}`;
    connectionUri = `${baseUri}${dbName}`;
    await mongoose.connect(connectionUri);
    if (syncIndexes) {
      await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).syncIndexes()));
    }
  });

  afterEach(async () => {
    const db = mongoose.connection.db;
    if (!db) return;
    const collections = await db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    connectionUri = undefined;
  });

  return {
    uri: () => {
      if (!connectionUri) throw new Error("withTestDb: not yet connected");
      return connectionUri;
    },
  };
}
