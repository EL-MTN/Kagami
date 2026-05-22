import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setupTestMongo, teardownTestMongo } from "./helpers/mongo.ts";

// Reproduce the orphaned-session defect: a transcript is persisted before
// extraction, and every batch's embed/extraction call errors. The pipeline
// used to swallow each batch error (continue) and return a zero-fact
// "success", leaving a transcript with no facts and no summary and no signal
// to the caller. It must now surface as a thrown, retryable error.
//
// We force the failure by mocking the `ai` SDK so embeds reject immediately
// (no model is wired in the test harness, and a real call would otherwise
// hang on the 15s abort timeout). cosineSimilarity is kept real.
vi.mock("ai", async (importActual) => {
  const actual = await importActual<typeof import("ai")>();
  return {
    ...actual,
    embed: vi.fn(() => Promise.reject(new Error("embed unavailable (test)"))),
    embedMany: vi.fn(() => Promise.reject(new Error("embedMany unavailable (test)"))),
    // session-summary swallows this and degrades to an empty summary
    generateObject: vi.fn(() => Promise.reject(new Error("generateObject unavailable (test)"))),
  };
});

const TRANSCRIPT = `---
id: orphan-test-0001
started_at: 2026-05-01T10:00:00Z
participants: [user, assistant]
---

## t-0001 user

My sister Mei is moving to Seattle in June for a new job at Boeing.

## t-0002 assistant

Got it — anything you want to remember about the move?

## t-0003 user

Yeah, her lease starts June 15th and I'm helping her drive up that weekend.

## t-0004 assistant

Noted. Want a reminder closer to the date?
`;

beforeAll(async () => {
  setupTestMongo("ingest_session");
  const { ensureIndexes } = await import("../src/storage/indexes.ts");
  await ensureIndexes({ allowMissingSearch: true });
});

beforeEach(async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("transcripts").deleteMany({});
  await db.collection("facts").deleteMany({});
  await db.collection("session_summaries").deleteMany({});
});

afterAll(teardownTestMongo);

it("throws IngestExtractionError when every batch fails, instead of a silent zero-fact success", async () => {
  const { ingestSessionFromString, IngestExtractionError } =
    await import("../src/ingest/sessions.ts");

  await expect(ingestSessionFromString({ transcript: TRANSCRIPT })).rejects.toBeInstanceOf(
    IngestExtractionError,
  );
});

it("still persists the transcript on total failure (orphan is now retryable, not lost)", async () => {
  const { ingestSessionFromString } = await import("../src/ingest/sessions.ts");
  const { getDb } = await import("../src/storage/mongo.ts");

  await ingestSessionFromString({ transcript: TRANSCRIPT }).catch(() => {});

  const db = await getDb();
  const transcripts = await db.collection("transcripts").find({}).toArray();
  const facts = await db.collection("facts").find({}).toArray();
  const summaries = await db.collection("session_summaries").find({}).toArray();

  // The exact orphan state — transcript on disk, nothing else — but the caller
  // saw an error (asserted above), so a retry can fill it in.
  expect(transcripts).toHaveLength(1);
  expect(transcripts[0]!._id).toBe("orphan-test-0001");
  expect(facts).toHaveLength(0);
  expect(summaries).toHaveLength(0);
});

it("consolidate reports every content-bearing batch as failed", async () => {
  const { parseTranscript } = await import("../src/ingest/transcript.ts");
  const { consolidate } = await import("../src/ingest/consolidate.ts");

  const result = await consolidate(parseTranscript(TRANSCRIPT));

  // 4 turns / BATCH_SIZE 2 = 2 content-bearing batches, both errored.
  expect(result.batches).toBe(2);
  expect(result.failed).toBe(2);
  expect(result.added).toBe(0);
});
