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
