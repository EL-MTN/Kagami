import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

beforeAll(async () => {
  setupTestMongo("facts");
  // Build the btree indexes. Search/vector indexes are skipped because
  // mongodb-memory-server is vanilla mongo without mongot. Dedup is
  // enforced upstream of storage at append.ts / consolidate.ts (cosine).
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes({ allowMissingSearch: true });
});

beforeEach(async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("facts").deleteMany({});
});

afterAll(teardownTestMongo);

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

it("readFacts returns empty array when collection is empty", async () => {
  const { readFacts } = await import("../src/storage/facts.ts");
  expect(await readFacts()).toEqual([]);
});

it("appendFacts then readFacts roundtrips", async () => {
  const { appendFacts, readFacts, newFactId } = await import("../src/storage/facts.ts");
  const a = makeFact({
    id: newFactId(),
    text: "User likes coffee",
    created_at: "2024-01-01T00:00:00Z",
    event_date: "2024-01-01",
    source_session: "raw/s1",
    embedding: [1, 0, 0],
  });
  const b = makeFact({
    id: newFactId(),
    text: "User has a cat named Mira",
    created_at: "2024-01-02T00:00:00Z",
    event_date: "2024-01-02",
    source_session: "raw/s2",
    embedding: [0, 1, 0],
  });
  await appendFacts([a]);
  await appendFacts([b]);
  const facts = await readFacts();
  expect(facts.length).toBe(2);
  expect(facts[0]!.text).toBe("User likes coffee");
  expect(facts[1]!.text).toBe("User has a cat named Mira");
  expect(facts[0]!.embedding).toEqual([1, 0, 0]);
});

it("readFactsInScope filters to the supplied scope", async () => {
  const { appendFacts, readFactsInScope, newFactId } = await import("../src/storage/facts.ts");
  await appendFacts([
    makeFact({ id: newFactId(), user_id: "alice" }),
    makeFact({ id: newFactId(), user_id: "bob" }),
    makeFact({ id: newFactId(), user_id: "alice", run_id: "r1" }),
  ]);
  const aliceAll = await readFactsInScope({ user_id: "alice" });
  expect(aliceAll.length).toBe(2);
  const aliceR1 = await readFactsInScope({ user_id: "alice", run_id: "r1" });
  expect(aliceR1.length).toBe(1);
  expect(aliceR1[0]!.run_id).toBe("r1");
});

it("normalizeCategory accepts the known list, falls back to misc otherwise", async () => {
  const { normalizeCategory, KIOKU_CATEGORIES } = await import("../src/ingest/consolidate.ts");
  for (const c of KIOKU_CATEGORIES) {
    expect(normalizeCategory(c)).toBe(c);
  }
  expect(normalizeCategory("PROFESSIONAL_DETAILS")).toBe("professional_details");
  expect(normalizeCategory("  food  ")).toBe("food");
  expect(normalizeCategory("not_a_real_category")).toBe("misc");
  expect(normalizeCategory(undefined)).toBe("misc");
  expect(normalizeCategory("")).toBe("misc");
});

it("appendFacts persists category", async () => {
  const { appendFacts, readFacts, newFactId } = await import("../src/storage/facts.ts");
  const f = makeFact({
    id: newFactId(),
    text: "User loves jazz",
    category: "music",
  });
  await appendFacts([f]);
  const facts = await readFacts();
  expect(facts.length).toBe(1);
  expect(facts[0]!.category).toBe("music");
});

it("appendFacts persists run_id, agent_id, and metadata", async () => {
  const { appendFacts, readFacts, newFactId } = await import("../src/storage/facts.ts");
  const f = makeFact({
    id: newFactId(),
    user_id: "alice",
    run_id: "session-1",
    agent_id: "kioku",
    metadata: { category: "food", confidence: 0.9 },
  });
  await appendFacts([f]);
  const facts = await readFacts();
  expect(facts.length).toBe(1);
  expect(facts[0]!.run_id).toBe("session-1");
  expect(facts[0]!.agent_id).toBe("kioku");
  expect(facts[0]!.metadata).toEqual({ category: "food", confidence: 0.9 });
});

it("appendFactsBulk on empty input returns empty array without LLM contact", async () => {
  const { appendFactsBulk } = await import("../src/ingest/append.ts");
  const out = await appendFactsBulk([]);
  expect(out).toEqual([]);
});

it("newFactId returns unique uuid-shaped strings", async () => {
  const { newFactId } = await import("../src/storage/facts.ts");
  const ids = new Set([newFactId(), newFactId(), newFactId()]);
  expect(ids.size).toBe(3);
  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  }
});

it("buildExtractionUserPrompt assembles all required sections in order", async () => {
  const { buildExtractionUserPrompt } = await import("../src/ingest/consolidate.ts");
  const prompt = buildExtractionUserPrompt({
    newMessages: [{ role: "user", content: "hi" }],
    observationDate: "2023-05-04",
    currentDate: "2026-05-02",
    existingMemories: [{ id: "uuid-1", text: "User likes pizza" }],
  });
  expect(prompt).toContain("## Summary");
  expect(prompt).toContain("## Last k Messages");
  expect(prompt).toContain("## Recently Extracted Memories");
  expect(prompt).toContain("## Existing Memories");
  expect(prompt).toContain("uuid-1");
  expect(prompt).toContain("User likes pizza");
  expect(prompt).toContain("## New Messages");
  expect(prompt).toContain('"role":"user"');
  expect(prompt).toContain("## Observation Date\n2023-05-04");
  expect(prompt).toContain("## Current Date\n2026-05-02");
  expect(prompt.endsWith("# Output:")).toBe(true);
});

it("buildExtractionUserPrompt threads summary into the Summary section", async () => {
  const { buildExtractionUserPrompt } = await import("../src/ingest/consolidate.ts");
  const summary =
    "User is Marcus, a senior engineer at Shopify. The conversation covered career milestones and family.";
  const prompt = buildExtractionUserPrompt({
    newMessages: [{ role: "user", content: "hi" }],
    observationDate: "2025-08-19",
    currentDate: "2026-05-04",
    summary,
  });
  expect(prompt).toContain(`## Summary\n${summary}`);
});
