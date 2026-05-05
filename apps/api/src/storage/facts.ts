import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { getDb } from './mongo.js';
import { recordEvents, type RecordEventInput } from './history.js';

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
  // to 'default' at the writer); run_id and agent_id are optional. The
  // hash unique index is scoped by (user_id, run_id, agent_id, hash) so
  // identical text under different scopes does not collide.
  user_id: string;
  run_id?: string;
  agent_id?: string;
  created_at: string;       // ISO timestamp of ingestion
  event_date: string;       // session timestamp the fact was extracted from
  source_session: string;   // e.g. "raw/answer_4be1b6b4_1"
  hash: string;             // md5 of text for dedup checks (unique-indexed)
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
interface FactDoc extends Omit<Fact, 'id'> {
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
  return db.collection<FactDoc>('facts');
}

export function newFactId(): string {
  return randomUUID();
}

export async function readFacts(): Promise<Fact[]> {
  const col = await factsCol();
  // Ascending created_at preserves the insertion-order semantics callers
  // had with the JSONL append-only file. _id breaks ties deterministically.
  const docs = await col.find({}).sort({ created_at: 1, _id: 1 }).toArray();
  return docs.map(fromDoc);
}

// Scope-bound read. Used by ingest paths so dedup context (md5 hashes,
// top-K cosine candidates) doesn't bleed across user/run/agent
// boundaries. Mongo treats absent fields as null, matching the semantics
// the writer uses when scope fields are unset.
export interface ScopeFilter {
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

  // Track which inserts actually landed so the audit log doesn't
  // emit ADD events for hash-deduped rows. Both the success path and
  // the partial-failure (dupes) path expose `insertedIds` keyed by
  // input index — only those indices are present after the call.
  let insertedIndices: Set<number>;
  try {
    const result = await col.insertMany(facts.map(toDoc), { ordered: false });
    insertedIndices = new Set(Object.keys(result.insertedIds).map(Number));
  } catch (err) {
    const e = err as {
      code?: number;
      writeErrors?: Array<{ code?: number }>;
      insertedIds?: Record<number, unknown>;
      result?: { insertedIds?: Record<number, unknown> };
    };
    const errs = Array.isArray(e.writeErrors) ? e.writeErrors : [];
    const allDupes =
      e.code === 11000 || (errs.length > 0 && errs.every((w) => w.code === 11000));
    if (!allDupes) throw err;
    const ids = e.insertedIds ?? e.result?.insertedIds ?? {};
    insertedIndices = new Set(Object.keys(ids).map(Number));
  }

  if (insertedIndices.size === 0) return;
  const events: RecordEventInput[] = [];
  for (let i = 0; i < facts.length; i++) {
    if (!insertedIndices.has(i)) continue;
    events.push({
      memory_id: facts[i]!.id,
      event: 'ADD',
      new_text: facts[i]!.text,
      actor,
    });
  }
  await recordEvents(events);
}
