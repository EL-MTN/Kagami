import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

// Curation-pass coverage: clustering mechanics, verdict application
// (drop / rewrite / merge) including history journaling and entity-link
// maintenance, and the fail-open posture on malformed verdicts.
//
// The `ai` SDK is mocked: generateObject returns whatever the active
// test enqueued, embeds return tiny deterministic vectors. Embedding
// dimension is irrelevant here — no $vectorSearch runs in this suite.

const verdictQueue: Array<{ actions: unknown[] }> = [];

vi.mock("ai", async (importActual) => {
  const actual = await importActual<typeof import("ai")>();
  return {
    ...actual,
    generateObject: vi.fn(() => {
      const next = verdictQueue.shift();
      if (!next) return Promise.reject(new Error("no verdict enqueued (test)"));
      return Promise.resolve({ object: next });
    }),
    embed: vi.fn(() => Promise.resolve({ embedding: [1, 0, 0] })),
    embedMany: vi.fn((opts: { values: string[] }) =>
      Promise.resolve({ embeddings: opts.values.map(() => [1, 0, 0]) }),
    ),
  };
});

// Distinct directions so clusterFacts sees controllable similarity:
// a/b are identical, c is orthogonal.
const E_A = [1, 0, 0];
const E_B = [1, 0, 0];
const E_C = [0, 1, 0];

function fact(id: string, text: string, embedding: number[], overrides: object = {}) {
  return {
    id,
    text,
    text_lemmatized: text.toLowerCase(),
    user_id: "default",
    created_at: new Date().toISOString(),
    event_date: "2026-06-01",
    source_session: "raw/test-session",
    embedding,
    ...overrides,
  };
}

beforeAll(async () => {
  setupTestMongo("curate");
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes({ allowMissingSearch: true });
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  verdictQueue.length = 0;
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("facts").deleteMany({});
  await db.collection("history").deleteMany({});
  await db.collection("entities").deleteMany({});
});

describe("clusterFacts", () => {
  it("groups cosine-near facts and batches singletons", async () => {
    const { clusterFacts } = await import("../src/ingest/curate.ts");
    const groups = clusterFacts(
      [fact("a", "A", E_A), fact("b", "B", E_B), fact("c", "C", E_C)] as never[],
      0.8,
    );
    // a+b cluster; c is a singleton batch.
    expect(groups).toHaveLength(2);
    const sizes = groups.map((g) => g.length).sort();
    expect(sizes).toEqual([1, 2]);
  });
});

describe("planCuration fail-open", () => {
  it("keeps a group untouched when the verdict misses ids", async () => {
    const { appendFacts } = await import("../src/storage/facts.ts");
    await appendFacts([fact("a", "Fact A", E_A), fact("b", "Fact B", E_B)] as never[]);

    // Verdict only covers "a" — invalid, group must fail open.
    verdictQueue.push({
      actions: [{ kind: "drop", ids: ["a"], text: "", event_date: "", category: "", reason: "x" }],
    });

    const { planCuration } = await import("../src/ingest/curate.ts");
    const plan = await planCuration();
    expect(plan.failedGroups).toBe(1);
    expect(plan.drops).toHaveLength(0);
    expect(plan.keep.sort()).toEqual(["a", "b"]);
  });

  it("keeps a group untouched when the LLM call rejects", async () => {
    const { appendFacts } = await import("../src/storage/facts.ts");
    await appendFacts([fact("a", "Fact A", E_A)] as never[]);
    // Nothing enqueued → generateObject rejects.
    const { planCuration } = await import("../src/ingest/curate.ts");
    const plan = await planCuration();
    expect(plan.failedGroups).toBe(1);
    expect(plan.keep).toEqual(["a"]);
  });
});

describe("applyCuration", () => {
  it("drop deletes the fact, journals DELETE, and unlinks entities", async () => {
    const { appendFacts } = await import("../src/storage/facts.ts");
    await appendFacts([
      fact("a", "User checked the time at 'Greenwich Observatory'", E_A),
      fact("b", "User lives near 'Greenwich Observatory'", E_B),
    ] as never[]);
    const { upsertEntitiesFromFacts } = await import("../src/storage/entities.ts");
    await upsertEntitiesFromFacts([
      fact("a", "User checked the time at 'Greenwich Observatory'", E_A),
      fact("b", "User lives near 'Greenwich Observatory'", E_B),
    ] as never[]);

    verdictQueue.push({
      actions: [
        { kind: "drop", ids: ["a"], text: "", event_date: "", category: "", reason: "narration" },
        { kind: "keep", ids: ["b"], text: "", event_date: "", category: "", reason: "" },
      ],
    });

    const { planCuration, applyCuration } = await import("../src/ingest/curate.ts");
    const plan = await planCuration();
    expect(plan.drops.map((d) => d.id)).toEqual(["a"]);

    const result = await applyCuration(plan);
    expect(result.dropped).toBe(1);

    const { getDb } = await import("../src/storage/mongo.ts");
    const db = await getDb();
    expect(await db.collection("facts").countDocuments()).toBe(1);
    const del = await db.collection("history").findOne({ memory_id: "a", event: "DELETE" });
    expect(del).not.toBeNull();
    expect(del!.old_text).toContain("checked the time");
    expect(del!.actor).toBe("curate");

    // Entity still exists (b links it) but no longer references a.
    const ent = await db.collection("entities").findOne({ text_lower: "greenwich observatory" });
    expect(ent).not.toBeNull();
    expect(ent!.linked_memory_ids).toEqual(["b"]);
  });

  it("merge of one rewrites in place with an UPDATE row", async () => {
    const { appendFacts } = await import("../src/storage/facts.ts");
    await appendFacts([
      fact("a", "User's birthday is April 11, as confirmed during the conversation", E_A),
    ] as never[]);

    verdictQueue.push({
      actions: [
        {
          kind: "merge",
          ids: ["a"],
          text: "User's birthday is April 11",
          event_date: "",
          category: "milestones",
          reason: "strip trailing conversation-date clause",
        },
      ],
    });

    const { planCuration, applyCuration } = await import("../src/ingest/curate.ts");
    const result = await applyCuration(await planCuration());
    expect(result.rewritten).toBe(1);
    expect(result.merged).toBe(0);

    const { getDb } = await import("../src/storage/mongo.ts");
    const db = await getDb();
    const doc = await db.collection("facts").findOne({ _id: "a" as never });
    expect(doc).not.toBeNull();
    expect(doc!.text).toBe("User's birthday is April 11");
    expect(doc!.category).toBe("milestones");
    const upd = await db.collection("history").findOne({ memory_id: "a", event: "UPDATE" });
    expect(upd).not.toBeNull();
    expect(upd!.old_text).toContain("as confirmed");
    expect(upd!.new_text).toBe("User's birthday is April 11");
  });

  it("merge of two replaces members with one provenance-tagged fact", async () => {
    const { appendFacts } = await import("../src/storage/facts.ts");
    await appendFacts([
      fact("a", "User scheduled an email to Mark", E_A, {
        event_date: "2026-06-05",
        created_at: "2026-06-05T00:00:00.000Z",
        metadata: { ingest_run: "r1", channel: "telegram" },
      }),
      fact("b", "User scheduled an email to Mark on June 5", E_B, {
        event_date: "2026-06-06",
        created_at: "2026-06-06T00:00:00.000Z",
        metadata: { ingest_run: "r2" },
      }),
    ] as never[]);

    verdictQueue.push({
      actions: [
        {
          kind: "merge",
          ids: ["a", "b"],
          text: "User scheduled a welcoming email to Mark, sent June 5, 2026",
          event_date: "2026-06-05",
          category: "",
          reason: "near-duplicates",
        },
      ],
    });

    const { planCuration, applyCuration } = await import("../src/ingest/curate.ts");
    const result = await applyCuration(await planCuration());
    expect(result.merged).toBe(1);
    expect(result.mergedAway).toBe(2);

    const { getDb } = await import("../src/storage/mongo.ts");
    const db = await getDb();
    const docs = await db.collection("facts").find({}).toArray();
    expect(docs).toHaveLength(1);
    const merged = docs[0]!;
    expect(merged.text).toContain("welcoming email");
    expect(merged.event_date).toBe("2026-06-05");
    // Member metadata carries forward (newest wins per key) so exact
    // metadata.* recall filters keep matching; curated_from is appended.
    expect(merged.metadata).toEqual({
      ingest_run: "r2",
      channel: "telegram",
      curated_from: ["a", "b"],
    });

    // Journal: ADD for the new fact, DELETE for both members.
    expect(
      await db.collection("history").countDocuments({ event: "DELETE", actor: "curate" }),
    ).toBe(2);
    expect(
      await db
        .collection("history")
        .countDocuments({ event: "ADD", actor: "curate", memory_id: merged._id }),
    ).toBe(1);
  });
});

it("skips a merge when a member fact vanished between plan and apply", async () => {
  const { appendFacts, deleteFacts } = await import("../src/storage/facts.ts");
  await appendFacts([
    fact("a", "User scheduled an email to Mark", E_A),
    fact("b", "User scheduled an email to Mark on June 5", E_B),
  ] as never[]);

  verdictQueue.push({
    actions: [
      {
        kind: "merge",
        ids: ["a", "b"],
        text: "User scheduled a welcoming email to Mark, sent June 5, 2026",
        event_date: "2026-06-05",
        category: "",
        reason: "near-duplicates",
      },
    ],
  });

  const { planCuration, applyCuration } = await import("../src/ingest/curate.ts");
  const plan = await planCuration();
  // The plan was built against both facts; delete one before applying.
  await deleteFacts(["b"], "test");

  const result = await applyCuration(plan);
  expect(result.staleSkipped).toBe(1);
  expect(result.merged).toBe(0);
  expect(result.mergedAway).toBe(0);

  // The survivor is untouched — the merged text (composed from BOTH
  // members) must not resurrect the deleted fact's content.
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  const docs = await db.collection("facts").find({}).toArray();
  expect(docs).toHaveLength(1);
  expect(docs[0]!._id).toBe("a");
  expect(docs[0]!.text).toBe("User scheduled an email to Mark");
});
