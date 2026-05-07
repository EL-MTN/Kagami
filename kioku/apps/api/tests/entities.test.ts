import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { randomUUID } from "node:crypto";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.KIOKU_MONGO_URI = replSet.getUri();
  process.env.KIOKU_MONGO_DB = `kioku_entities_test_${Date.now()}`;
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes({ allowMissingSearch: true });
});

beforeEach(async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("entities").deleteMany({});
});

afterAll(async () => {
  const { closeMongo } = await import("../src/storage/mongo.ts");
  await closeMongo();
  await replSet.stop();
});

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
