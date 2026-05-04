import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { getDb } from './mongo.js';

// Audit log of fact mutations. Modeled on mem0's history table:
// every ADD / UPDATE / DELETE leaves a row, capturing old + new text
// where applicable so a fact's evolution can be replayed.
//
// Event types:
//   ADD    — fact created.       new_text required, old_text absent.
//   UPDATE — fact's text changed. old_text + new_text both required.
//   DELETE — fact removed.       old_text required, new_text absent.
//
// Indexed by { memory_id, created_at desc } via ensureIndexes() so a
// fact's full journal is one cheap range scan.

export type HistoryEventKind = 'ADD' | 'UPDATE' | 'DELETE';

export interface HistoryEvent {
  id: string;
  memory_id: string;
  event: HistoryEventKind;
  old_text?: string;
  new_text?: string;
  actor: string;            // free-form: 'system', 'consolidate', 'append', etc.
  created_at: string;       // ISO timestamp
}

interface HistoryDoc extends Omit<HistoryEvent, 'id'> {
  _id: string;
}

function fromDoc(d: HistoryDoc): HistoryEvent {
  const { _id, ...rest } = d;
  return { id: _id, ...rest };
}

async function historyCol(): Promise<Collection<HistoryDoc>> {
  const db = await getDb();
  return db.collection<HistoryDoc>('history');
}

export interface RecordEventInput {
  memory_id: string;
  event: HistoryEventKind;
  old_text?: string;
  new_text?: string;
  actor?: string;
}

function buildDoc(input: RecordEventInput): HistoryDoc {
  return {
    _id: randomUUID(),
    memory_id: input.memory_id,
    event: input.event,
    ...(input.old_text !== undefined ? { old_text: input.old_text } : {}),
    ...(input.new_text !== undefined ? { new_text: input.new_text } : {}),
    actor: input.actor ?? 'system',
    created_at: new Date().toISOString(),
  };
}

export async function recordEvent(input: RecordEventInput): Promise<void> {
  const col = await historyCol();
  await col.insertOne(buildDoc(input));
}

export async function recordEvents(inputs: RecordEventInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const col = await historyCol();
  await col.insertMany(inputs.map(buildDoc), { ordered: false });
}

// Return the journal for one fact, newest first. The btree on
// { memory_id, created_at: -1 } makes this an index-only scan.
export async function readHistoryFor(memoryId: string): Promise<HistoryEvent[]> {
  const col = await historyCol();
  const docs = await col
    .find({ memory_id: memoryId })
    .sort({ created_at: -1 })
    .toArray();
  return docs.map(fromDoc);
}
