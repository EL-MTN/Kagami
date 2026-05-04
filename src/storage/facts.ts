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

export async function appendFacts(facts: Fact[], actor?: string): Promise<void> {
  if (facts.length === 0) return;
  const col = await factsCol();

  // Track which inserts actually landed so the audit log doesn't
  // emit ADD events for hash-deduped rows. Both the success path and
  // the partial-failure (dupes) path expose `insertedIds` keyed by
  // input index — only those indices are present after the call.
  let insertedIndices: Set<number> = new Set();
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

// Replace-all semantics, matching the prior JSONL fs.writeFile contract.
// Currently unused by production code — append-only is the norm — but
// the export stays so future overwrite paths have somewhere to land.
//
// Diffs the current state against the new set so the audit log records
// UPDATE for unchanged-id-changed-text, DELETE for removed ids, and
// ADD for new ids. Old text is captured before the destructive write.
export async function rewriteFacts(facts: Fact[], actor?: string): Promise<void> {
  const col = await factsCol();

  const before = await col
    .find({})
    .project<{ _id: string; text: string }>({ _id: 1, text: 1 })
    .toArray();
  const beforeById = new Map(before.map((d) => [d._id, d.text]));
  const afterById = new Map(facts.map((f) => [f.id, f.text]));

  const events: RecordEventInput[] = [];
  for (const [id, oldText] of beforeById) {
    const newText = afterById.get(id);
    if (newText === undefined) {
      events.push({ memory_id: id, event: 'DELETE', old_text: oldText, actor });
    } else if (newText !== oldText) {
      events.push({
        memory_id: id,
        event: 'UPDATE',
        old_text: oldText,
        new_text: newText,
        actor,
      });
    }
  }
  for (const f of facts) {
    if (!beforeById.has(f.id)) {
      events.push({ memory_id: f.id, event: 'ADD', new_text: f.text, actor });
    }
  }

  await col.deleteMany({});
  if (facts.length > 0) {
    await col.insertMany(facts.map(toDoc), { ordered: false });
  }
  if (events.length > 0) await recordEvents(events);
}
