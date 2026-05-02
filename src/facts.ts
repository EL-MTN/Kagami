import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from './paths.js';

// Mem0-faithful atomic-fact storage. One Fact per line in .memory/facts.jsonl.
// Each fact carries its embedding so retrieval is just embed(question) +
// in-memory cosine — no vector DB required at our scale.
//
// Mirrors mem0's memory schema:
//   id, text (the fact), user_id, created_at (ingestion ts),
//   metadata (event_date, source session, hash for dedup).
// embedding is persisted alongside so we don't re-embed at query time.

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
  hash: string;             // md5 of text for dedup checks
  embedding: number[];
}

export function newFactId(): string {
  return randomUUID();
}

export async function readFacts(): Promise<Fact[]> {
  try {
    const raw = await fs.readFile(paths.facts, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Fact);
  } catch {
    return [];
  }
}

export async function appendFacts(facts: Fact[]): Promise<void> {
  if (facts.length === 0) return;
  await fs.mkdir(path.dirname(paths.facts), { recursive: true });
  const lines = facts.map((f) => JSON.stringify(f)).join('\n') + '\n';
  await fs.appendFile(paths.facts, lines);
}

// Phase 2 — rewrites the entire JSONL after a manage step decides
// UPDATE/DELETE. Cheap at our scale (≤10K facts).
export async function rewriteFacts(facts: Fact[]): Promise<void> {
  await fs.mkdir(path.dirname(paths.facts), { recursive: true });
  const lines = facts.map((f) => JSON.stringify(f)).join('\n') + (facts.length > 0 ? '\n' : '');
  await fs.writeFile(paths.facts, lines);
}
