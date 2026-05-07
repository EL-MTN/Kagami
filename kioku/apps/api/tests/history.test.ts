import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.KIOKU_MONGO_URI = replSet.getUri();
  process.env.KIOKU_MONGO_DB = `kioku_history_test_${Date.now()}`;
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes({ allowMissingSearch: true });
});

beforeEach(async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await Promise.all([
    db.collection("facts").deleteMany({}),
    db.collection("history").deleteMany({}),
  ]);
});

afterAll(async () => {
  const { closeMongo } = await import("../src/storage/mongo.ts");
  await closeMongo();
  await replSet.stop();
});

function makeFact(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    text: "placeholder",
    user_id: "default",
    created_at: "2024-01-01T00:00:00Z",
    event_date: "2024-01-01",
    source_session: "raw/s",
    embedding: [1, 0, 0],
    ...overrides,
  };
}

it("appendFacts emits one ADD event per inserted fact", async () => {
  const { appendFacts, newFactId } = await import("../src/storage/facts.ts");
  const { readHistoryFor } = await import("../src/storage/history.ts");
  const a = makeFact({ id: newFactId(), text: "A" });
  const b = makeFact({ id: newFactId(), text: "B" });
  await appendFacts([a, b], "append");
  const histA = await readHistoryFor(a.id);
  const histB = await readHistoryFor(b.id);
  expect(histA.length).toBe(1);
  expect(histA[0]!.event).toBe("ADD");
  expect(histA[0]!.new_text).toBe("A");
  expect(histA[0]!.actor).toBe("append");
  expect(histB.length).toBe(1);
  expect(histB[0]!.event).toBe("ADD");
});

it("readHistoryFor returns events newest first", async () => {
  const { recordEvent, readHistoryFor } = await import("../src/storage/history.ts");
  await recordEvent({ memory_id: "mid", event: "ADD", new_text: "a" });
  await new Promise((r) => setTimeout(r, 5));
  await recordEvent({ memory_id: "mid", event: "UPDATE", old_text: "a", new_text: "b" });
  await new Promise((r) => setTimeout(r, 5));
  await recordEvent({ memory_id: "mid", event: "DELETE", old_text: "b" });
  const hist = await readHistoryFor("mid");
  expect(hist.length).toBe(3);
  expect(hist[0]!.event).toBe("DELETE");
  expect(hist[1]!.event).toBe("UPDATE");
  expect(hist[2]!.event).toBe("ADD");
});
