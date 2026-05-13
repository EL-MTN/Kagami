import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

beforeAll(async () => {
  setupTestMongo("entities");
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes({ allowMissingSearch: true });
});

beforeEach(async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("entities").deleteMany({});
});

afterAll(teardownTestMongo);

function makeDoc(overrides: Record<string, unknown> = {}) {
  const text = (overrides.text as string) ?? "Mira";
  return {
    _id: randomUUID(),
    text,
    text_lower: text.toLowerCase(),
    entity_type: "PROPER",
    embedding: [1, 0, 0],
    linked_memory_ids: [] as string[],
    ...overrides,
  };
}

it("text_lower unique index rejects duplicate keys", async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("entities").insertOne(makeDoc({ text: "Mira" }) as never);
  await expect(
    db.collection("entities").insertOne(makeDoc({ text: "Mira" }) as never),
  ).rejects.toThrow(/E11000|duplicate key/);
});

it("parallel upsert-style updateOnes converge on union of linked_memory_ids", async () => {
  // Mirrors the atomic-upsert pattern upsertEntitiesFromFacts uses,
  // without going through embedTexts (which needs a live provider).
  // Demonstrates that two writers racing on the same text_lower end up
  // with both fact ids linked, not one clobbering the other.
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  const col = db.collection("entities");

  const upsert = (memId: string) =>
    col.updateOne(
      { text_lower: "mira" },
      {
        $setOnInsert: {
          _id: randomUUID(),
          text: "Mira",
          text_lower: "mira",
          entity_type: "PROPER",
          embedding: [1, 0, 0],
        },
        $addToSet: { linked_memory_ids: { $each: [memId] } },
      },
      { upsert: true },
    );

  await Promise.all([upsert("fact-A"), upsert("fact-B"), upsert("fact-C")]);
  const docs = await col.find({}).toArray();
  expect(docs.length).toBe(1);
  const linked = (docs[0] as unknown as { linked_memory_ids: string[] }).linked_memory_ids;
  expect([...linked].sort()).toEqual(["fact-A", "fact-B", "fact-C"]);
});

it("upsertEntitiesFromFacts stores new entities with empty embeddings when embedding fails", async () => {
  vi.resetModules();
  vi.doMock("../src/llm.ts", () => ({
    embedTexts: vi.fn(async () => {
      throw new Error("embedding provider down");
    }),
  }));

  const { upsertEntitiesFromFacts } = await import("../src/storage/entities.ts");
  const result = await upsertEntitiesFromFacts([
    {
      id: "fact-entity-failure",
      text: "Mira visited New York.",
      user_id: "default",
      created_at: "2026-05-12T00:00:00Z",
      event_date: "2026-05-12",
      source_session: "raw/test",
      embedding: [1, 0, 0],
    },
  ]);

  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  const docs = await db.collection("entities").find({}).sort({ text_lower: 1 }).toArray();

  expect(result).toEqual({ created: 2, linked: 2 });
  expect(
    docs.map((doc) => ({
      text: doc.text,
      embedding: doc.embedding,
      linked_memory_ids: doc.linked_memory_ids,
    })),
  ).toEqual([
    { text: "Mira", embedding: [], linked_memory_ids: ["fact-entity-failure"] },
    { text: "New York", embedding: [], linked_memory_ids: ["fact-entity-failure"] },
  ]);

  vi.doUnmock("../src/llm.ts");
  vi.resetModules();
});
