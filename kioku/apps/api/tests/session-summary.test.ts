import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryReplSet } from "mongodb-memory-server";

let replSet: MongoMemoryReplSet;

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.KIOKU_MONGO_URI = replSet.getUri();
  process.env.KIOKU_MONGO_DB = `kioku_session_summary_test_${Date.now()}`;
});

beforeEach(async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection("session_summaries").deleteMany({});
});

after(async () => {
  const { closeMongo } = await import("../src/storage/mongo.ts");
  await closeMongo();
  await replSet.stop();
});

interface CachedSummary {
  _id: string;
  summary: string;
  turn_count: number;
  created_at: string;
}

void test("getOrComputeSessionSummary returns the cached summary without recomputing", async () => {
  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  await db.collection<CachedSummary>("session_summaries").insertOne({
    _id: "raw/cached-session",
    summary: "pre-cached narrative summary",
    turn_count: 4,
    created_at: "2025-01-01T00:00:00Z",
  });

  const { getOrComputeSessionSummary } = await import("../src/ingest/session-summary.ts");
  // Same turn_count as the cached doc — should short-circuit and return
  // the cached summary without invoking the LLM. (Test harness has no
  // real model wired up; an LLM call would fail loudly.)
  const turns = [
    { role: "user", text: "a" },
    { role: "assistant", text: "b" },
    { role: "user", text: "c" },
    { role: "assistant", text: "d" },
  ];
  const out = await getOrComputeSessionSummary({
    sourceSession: "raw/cached-session",
    turns,
  });
  assert.equal(out, "pre-cached narrative summary");
});

void test("getOrComputeSessionSummary on empty turns short-circuits to empty", async () => {
  const { getOrComputeSessionSummary } = await import("../src/ingest/session-summary.ts");
  const out = await getOrComputeSessionSummary({
    sourceSession: "raw/empty",
    turns: [],
  });
  assert.equal(out, "");

  const { getDb } = await import("../src/storage/mongo.ts");
  const db = await getDb();
  const doc = await db.collection<CachedSummary>("session_summaries").findOne({ _id: "raw/empty" });
  assert.equal(doc, null);
});
