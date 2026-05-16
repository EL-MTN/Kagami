import { afterAll, beforeAll, expect, it } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

beforeAll(() => setupTestMongo("indexes"));
afterAll(teardownTestMongo);

it("ensureIndexes creates the logs time-series collection and indexes", async () => {
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  const { getDb } = await import("../src/storage/mongo.ts");

  await ensureIndexes();

  const db = await getDb();
  const collections = await db.listCollections({ name: "logs" }).toArray();
  expect(collections).toHaveLength(1);
  expect(collections[0]!.type).toBe("timeseries");

  const indexes = await db.collection("logs").indexes();
  const names = indexes.map((i) => i.name);
  expect(names).toEqual(
    expect.arrayContaining(["logs_service_ts", "logs_trace_id", "logs_level_ts"]),
  );
});

it("ensureIndexes is idempotent across calls", async () => {
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes();
  await ensureIndexes();
  await ensureIndexes();
});

it("gives the errors registry a lastSeen TTL (default 90 days)", async () => {
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  const { getDb } = await import("../src/storage/mongo.ts");

  await ensureIndexes();

  const db = await getDb();
  const idx = (await db.collection("errors").indexes()).find((i) => i.name === "errors_last_seen");
  expect(idx).toBeDefined();
  expect(idx!.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
});

it("reconciles a pre-existing non-TTL errors_last_seen index in place", async () => {
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  const { getDb } = await import("../src/storage/mongo.ts");

  const db = await getDb();
  // Earlier tests in this file already created the TTL index (shared DB).
  // Drop + recreate WITHOUT a TTL to simulate a deployment that created the
  // index before this change, then prove ensureIndexes reconciles it.
  await db
    .collection("errors")
    .dropIndex("errors_last_seen")
    .catch(() => undefined);
  await db.collection("errors").createIndex({ lastSeen: -1 }, { name: "errors_last_seen" });

  await ensureIndexes();

  const idx = (await db.collection("errors").indexes()).find((i) => i.name === "errors_last_seen");
  expect(idx!.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
});
