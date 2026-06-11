import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import { getDb } from "./mongo.js";
import { recordEvents, type RecordEventInput } from "./history.js";

// Atomic-fact storage. Each row is one Fact in the `facts` collection.
// The embedding is stored alongside the text so retrieval is just
// $vectorSearch + $search — no separate vector store, no re-embedding.

export interface Fact {
  id: string;
  text: string;
  // Pre-lemmatized text used by the BM25 hybrid ranker. Older facts that
  // predate the hybrid layer may be missing this field; readers should
  // tolerate absence and recompute via lemmatizeForBm25(text) on the fly.
  text_lemmatized?: string;
  // Scopes — mem0-OSS-shaped multi-tenancy. user_id is required (defaults
  // to 'default' at the writer); run_id and agent_id are optional. Dedup
  // is cosine-based at the ingest layer (append.ts / consolidate.ts);
  // there is no storage-layer dedup index.
  user_id: string;
  run_id?: string;
  agent_id?: string;
  created_at: string; // ISO timestamp of ingestion
  event_date: string; // session timestamp the fact was extracted from
  source_session: string; // e.g. "raw/answer_4be1b6b4_1"
  embedding: number[];
  // Free-form metadata. Stored as-is; flat string/number/boolean keys are
  // filterable at query time via post-vector-search $match. Nested objects
  // and arrays are persisted but not indexed.
  metadata?: Record<string, unknown>;
  // Mem0-OSS-style category tag. One of a fixed enumerated list (see
  // prompts/extraction.md → Categories). Indexed as a filter field on
  // facts_vec and a token field on facts_text so retrieval filters can
  // push it down. Optional — pre-categorization facts have no value here.
  category?: string;
}

// Internal Mongo doc shape: the public `id` field maps to `_id` so we
// have one canonical identifier per row (matches the schema in plan.md).
interface FactDoc extends Omit<Fact, "id"> {
  _id: string;
}

function toDoc(f: Fact): FactDoc {
  const { id, ...rest } = f;
  return { _id: id, ...rest };
}

function fromDoc(d: FactDoc): Fact {
  const { _id, ...rest } = d;
  return { id: _id, ...rest };
}

async function factsCol(): Promise<Collection<FactDoc>> {
  const db = await getDb();
  return db.collection<FactDoc>("facts");
}

export function newFactId(): string {
  return randomUUID();
}

export async function readFacts(): Promise<Fact[]> {
  const col = await factsCol();
  // Ascending created_at gives callers insertion-order semantics; _id
  // breaks ties deterministically.
  const docs = await col.find({}).sort({ created_at: 1, _id: 1 }).toArray();
  return docs.map(fromDoc);
}

// Scope-bound read. Used by ingest paths so dedup context (cosine
// candidates) doesn't bleed across user/run/agent boundaries. Mongo
// treats absent fields as null, matching the semantics the writer uses
// when scope fields are unset.
interface ScopeFilter {
  user_id?: string;
  run_id?: string;
  agent_id?: string;
}

export async function readFactsInScope(scope: ScopeFilter): Promise<Fact[]> {
  const col = await factsCol();
  const q: Record<string, unknown> = {};
  if (scope.user_id !== undefined) q.user_id = scope.user_id;
  if (scope.run_id !== undefined) q.run_id = scope.run_id;
  if (scope.agent_id !== undefined) q.agent_id = scope.agent_id;
  const docs = await col.find(q).sort({ created_at: 1, _id: 1 }).toArray();
  return docs.map(fromDoc);
}

export async function appendFacts(facts: Fact[], actor?: string): Promise<void> {
  if (facts.length === 0) return;
  const col = await factsCol();

  // No storage-layer dedup index. Dedup is enforced upstream by cosine
  // checks in append.ts (lock-serialized) and consolidate.ts. Any 11000
  // here would be an _id collision, which is a programming error worth
  // surfacing rather than swallowing.
  await col.insertMany(facts.map(toDoc), { ordered: false });

  const events: RecordEventInput[] = facts.map((f) => ({
    memory_id: f.id,
    event: "ADD",
    new_text: f.text,
    actor,
  }));
  await recordEvents(events);
}

// Curation-only mutations. The ingest path never updates or deletes a
// fact ("atomic facts are write-once"); the curation pass (ingest/
// curate.ts) is the sanctioned exception, and every mutation it makes
// journals an UPDATE / DELETE row in `history`.

export async function deleteFacts(ids: string[], actor?: string): Promise<number> {
  if (ids.length === 0) return 0;
  const col = await factsCol();
  const docs = await col
    .find({ _id: { $in: ids } })
    .project<{ _id: string; text: string }>({ text: 1 })
    .toArray();
  if (docs.length === 0) return 0;
  await col.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
  await recordEvents(
    docs.map((d) => ({
      memory_id: d._id,
      event: "DELETE" as const,
      old_text: d.text,
      actor,
    })),
  );
  return docs.length;
}

export interface FactRewrite {
  text: string;
  text_lemmatized: string;
  embedding: number[];
  event_date?: string;
  category?: string;
}

// In-place rewrite keeping the fact's id stable so entity links and
// source_session survive. Returns the post-rewrite fact, or null when
// the id doesn't exist.
export async function rewriteFact(
  id: string,
  changes: FactRewrite,
  actor?: string,
): Promise<Fact | null> {
  const col = await factsCol();
  const before = await col.findOne({ _id: id });
  if (!before) return null;
  const $set: Partial<FactDoc> = {
    text: changes.text,
    text_lemmatized: changes.text_lemmatized,
    embedding: changes.embedding,
    ...(changes.event_date !== undefined ? { event_date: changes.event_date } : {}),
    ...(changes.category !== undefined ? { category: changes.category } : {}),
  };
  await col.updateOne({ _id: id }, { $set });
  await recordEvents([
    {
      memory_id: id,
      event: "UPDATE",
      old_text: before.text,
      new_text: changes.text,
      actor,
    },
  ]);
  return fromDoc({ ...before, ...$set });
}
