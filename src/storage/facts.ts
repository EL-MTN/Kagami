import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { getDb } from './mongo.js';

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
  user_id: string;
  created_at: string;       // ISO timestamp of ingestion
  event_date: string;       // session timestamp the fact was extracted from
  source_session: string;   // e.g. "raw/answer_4be1b6b4_1"
  hash: string;             // md5 of text for dedup checks (unique-indexed)
  embedding: number[];
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

export async function appendFacts(facts: Fact[]): Promise<void> {
  if (facts.length === 0) return;
  const col = await factsCol();
  try {
    await col.insertMany(facts.map(toDoc), { ordered: false });
  } catch (err) {
    // The `facts_hash_unique` index does the dedup work — duplicate rows
    // surface here as code 11000. With ordered:false, every non-dupe still
    // landed; we only re-throw if something other than dupes failed.
    const e = err as { code?: number; writeErrors?: Array<{ code?: number }> };
    const errs = Array.isArray(e.writeErrors) ? e.writeErrors : [];
    const allDupes =
      e.code === 11000 || (errs.length > 0 && errs.every((w) => w.code === 11000));
    if (!allDupes) throw err;
  }
}

// Replace-all semantics, matching the prior JSONL fs.writeFile contract.
// Currently unused by production code — append-only is the norm — but the
// export stays so future overwrite paths have somewhere to land.
//
// TODO(phase 6): every overwrite must emit a history record (old_text,
// new_text, event=UPDATE|DELETE) before it lands.
export async function rewriteFacts(facts: Fact[]): Promise<void> {
  const col = await factsCol();
  await col.deleteMany({});
  if (facts.length === 0) return;
  await col.insertMany(facts.map(toDoc), { ordered: false });
}
