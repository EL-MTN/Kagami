import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

// Controllable embed mock: deterministic tiny vectors normally, a
// rejected promise when a test flips embedShouldFail (exercising the
// skip-new-entities-on-failure path). cosineSimilarity stays real.
let embedShouldFail = false;
vi.mock("ai", async (importActual) => {
  const actual = await importActual<typeof import("ai")>();
  return {
    ...actual,
    embed: vi.fn(() => Promise.resolve({ embedding: [1, 0, 0] })),
    embedMany: vi.fn((opts: { values: string[] }) =>
      embedShouldFail
        ? Promise.reject(new Error("embed down (test)"))
        : Promise.resolve({ embeddings: opts.values.map(() => [1, 0, 0]) }),
    ),
  };
});

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

// NOTE: the previous contract here ("store new entities with empty
// embeddings when embedding fails") was deliberately replaced: an empty
// vector never matches $vectorSearch and nothing ever re-embedded it,
// so a transient outage poisoned the entity forever. New entities are
// now skipped on failure (self-healing on next mention or via
// relinkAllEntities), and existing-link updates still proceed.
it("embed failure skips new entities instead of persisting empty embeddings", async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  // Pre-existing entity the fact also mentions — its link update must
  // survive the embed outage.
  await db.collection("entities").insertOne(makeDoc({ text: "Mira" }) as never);

  embedShouldFail = true;
  try {
    const { upsertEntitiesFromFacts } = await import("../src/storage/entities.ts");
    await upsertEntitiesFromFacts([
      {
        id: "fact-embed-fail",
        text: "User met Mira in Zurich",
        user_id: "default",
        created_at: new Date().toISOString(),
        event_date: "2026-06-01",
        source_session: "raw/s",
        embedding: [1, 0, 0],
      },
    ]);
  } finally {
    embedShouldFail = false;
  }

  const { getDb: getDb2 } = await import("../src/storage/mongo.ts");
  const db2 = await getDb2();
  // No empty-embedding rows persisted; the new entity was skipped.
  expect(await db2.collection("entities").countDocuments({ embedding: { $size: 0 } })).toBe(0);
  expect(await db2.collection("entities").findOne({ text_lower: "zurich" })).toBeNull();
  // The existing entity still got the link.
  const mira = await db2.collection("entities").findOne({ text_lower: "mira" });
  expect(mira!.linked_memory_ids).toContain("fact-embed-fail");
});

it("relinkAllEntities purges empty-embedding rows and restores missing links", async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("facts").deleteMany({});
  // A fact whose entities were never linked (simulated past upsert failure)
  // and a legacy empty-embedding row blocking re-embed of "Zurich".
  await db.collection("facts").insertOne({
    _id: "fact-relink",
    text: "User met Mira in Zurich",
    user_id: "default",
    created_at: new Date().toISOString(),
    event_date: "2026-06-01",
    source_session: "raw/s",
    embedding: [1, 0, 0],
  } as never);
  await db.collection("entities").insertOne(makeDoc({ text: "Zurich", embedding: [] }) as never);

  const { relinkAllEntities } = await import("../src/storage/entities.ts");
  const r = await relinkAllEntities({ user_id: "default" });
  expect(r.purgedEmpty).toBe(1);

  const zurich = await db.collection("entities").findOne({ text_lower: "zurich" });
  expect(zurich).not.toBeNull();
  expect(zurich!.embedding).toEqual([1, 0, 0]);
  expect(zurich!.linked_memory_ids).toContain("fact-relink");
  const mira = await db.collection("entities").findOne({ text_lower: "mira" });
  expect(mira!.linked_memory_ids).toContain("fact-relink");
});

it("scoped relink preserves empty rows linked to out-of-scope facts", async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("facts").deleteMany({});
  // In-scope fact mentioning Mira; an empty row fully in scope (Mira's
  // own fact ids) gets purged+recreated, while an empty row linked to an
  // out-of-scope fact must survive untouched.
  await db.collection("facts").insertOne({
    _id: "fact-scoped",
    text: "User met Mira yesterday",
    user_id: "default",
    created_at: new Date().toISOString(),
    event_date: "2026-06-01",
    source_session: "raw/s",
    embedding: [1, 0, 0],
  } as never);
  await db
    .collection("entities")
    .insertOne(
      makeDoc({ text: "Mira", embedding: [], linked_memory_ids: ["fact-scoped"] }) as never,
    );
  await db
    .collection("entities")
    .insertOne(
      makeDoc({ text: "Zurich", embedding: [], linked_memory_ids: ["other-vault-fact"] }) as never,
    );

  const { relinkAllEntities } = await import("../src/storage/entities.ts");
  const r = await relinkAllEntities({ user_id: "default" });
  expect(r.purgedEmpty).toBe(1); // only the fully-in-scope row

  const mira = await db.collection("entities").findOne({ text_lower: "mira" });
  expect(mira!.embedding).toEqual([1, 0, 0]); // recreated with a real embedding
  expect(mira!.linked_memory_ids).toContain("fact-scoped");
  const zurich = await db.collection("entities").findOne({ text_lower: "zurich" });
  expect(zurich).not.toBeNull(); // out-of-scope row untouched
  expect(zurich!.embedding).toEqual([]);
  expect(zurich!.linked_memory_ids).toEqual(["other-vault-fact"]);
});
