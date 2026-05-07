import { afterAll, beforeAll, expect, it } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

beforeAll(() => {
  setupTestMongo("mongo");
  // mongodb-memory-server is vanilla mongo without mongot. $listSearchIndexes
  // throws before we'd ever hit the embedding provider, and allowMissingSearch
  // below swallows that — so no embedding probe runs in this test.
});

afterAll(teardownTestMongo);

it("ensureIndexes creates btree indexes on facts/entities/history", async () => {
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  const { getDb } = await import("../src/storage/mongo.ts");

  await ensureIndexes({ allowMissingSearch: true });

  const db = await getDb();
  const factIdx = await db.collection("facts").indexes();
  const entIdx = await db.collection("entities").indexes();
  const histIdx = await db.collection("history").indexes();

  // facts_hash_unique was removed when storage-layer dedup moved to
  // cosine in append.ts / consolidate.ts. ensureIndexes now drops it
  // if a legacy deployment still has it, but never creates it.
  expect(factIdx.find((i) => i.name === "facts_hash_unique")).toBeFalsy();
  expect(factIdx.find((i) => i.name === "facts_user_created")).toBeTruthy();
  expect(entIdx.find((i) => i.name === "entities_text_lower_unique")?.unique).toBe(true);
  expect(histIdx.find((i) => i.name === "history_memory_created")).toBeTruthy();
});

it("ensureIndexes is idempotent across calls", async () => {
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes({ allowMissingSearch: true });
  await ensureIndexes({ allowMissingSearch: true });
  await ensureIndexes({ allowMissingSearch: true });
  // No throw — same indexes stay in place.
});
