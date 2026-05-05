import type { Collection } from 'mongodb';
import { getDb } from './mongo.js';
import type { Transcript } from '../types.js';

// Source-of-truth for the messages a session was extracted from. Holds
// the parsed transcript so re-ingest is filesystem-free: consolidate()
// reads from this collection, hash-dedups against the existing facts
// pass, and short-circuits writes when nothing has changed.
//
// Keyed by sessionId (the value of frontmatter.id). Facts reference back
// via `source_session: "raw/<sessionId>"` — the "raw/" prefix is a
// vestigial namespace marker preserved for compatibility with existing
// rows; the transcript collection itself stores the bare id.

interface TranscriptDoc {
  _id: string;                 // sessionId
  user_id?: string;
  run_id?: string;
  agent_id?: string;
  started_at: string;          // ISO timestamp from frontmatter
  turns: Transcript['turns'];
  created_at: string;          // ISO timestamp of first ingest
  updated_at: string;          // ISO timestamp of latest upsert
}

async function transcriptsCol(): Promise<Collection<TranscriptDoc>> {
  const db = await getDb();
  return db.collection<TranscriptDoc>('transcripts');
}

export interface UpsertTranscriptInput {
  transcript: Transcript;
  user_id?: string;
  run_id?: string;
  agent_id?: string;
}

export async function upsertTranscript(input: UpsertTranscriptInput): Promise<void> {
  const col = await transcriptsCol();
  const now = new Date().toISOString();
  const id = input.transcript.frontmatter.id;
  const setFields: Partial<TranscriptDoc> = {
    started_at: input.transcript.frontmatter.started_at,
    turns: input.transcript.turns,
    updated_at: now,
    ...(input.user_id !== undefined ? { user_id: input.user_id } : {}),
    ...(input.run_id !== undefined ? { run_id: input.run_id } : {}),
    ...(input.agent_id !== undefined ? { agent_id: input.agent_id } : {}),
  };
  await col.updateOne(
    { _id: id },
    {
      $set: setFields,
      $setOnInsert: { created_at: now },
    },
    { upsert: true },
  );
}

export async function readTranscriptBySessionId(
  sessionId: string,
): Promise<Transcript | null> {
  const col = await transcriptsCol();
  const doc = await col.findOne({ _id: sessionId });
  if (!doc) return null;
  return {
    frontmatter: { id: doc._id, started_at: doc.started_at },
    turns: doc.turns,
  };
}
