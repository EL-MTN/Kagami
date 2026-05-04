import { createHash } from 'node:crypto';
import { cosineSimilarity } from 'ai';
import { embedQuestion } from '../llm.js';
import { lemmatizeForBm25 } from '../retrieval/text.js';
import {
  appendFacts,
  newFactId,
  readFactsInScope,
  type Fact,
} from '../storage/facts.js';
import { upsertEntitiesFromFacts } from '../storage/entities.js';
import { logger } from '../logger.js';

// Single-fact append path. Bypasses the transcript-batch extraction
// pipeline in consolidate.ts — the caller has already decided this is a
// fact worth keeping. We still:
//   - md5-dedup against existing fact text (hard skip, exact dup)
//   - cosine-dedup against the top existing fact (skip if >= NEAR_DUPE)
//   - embed and lemmatize for BM25
//   - upsert entities so the entity-boost ranker picks it up
//
// Concurrent callers serialize on a process-wide async lock. The hash and
// entity paths are race-safe via Mongo primitives (unique index +
// $setOnInsert/$addToSet upserts), but the cosine near-dupe check is a
// read-then-act sequence: two concurrent calls with cosine-similar but
// byte-distinct text would each see no near-dupe and both insert. The
// hash unique index can't catch this (different hashes); $vectorSearch
// can't atomically guard insertion. Phase 5 deleted the vault-wide
// mutex on the strength of Mongo atomicity — but the cosine path was
// never atomic, so we re-introduce a narrow lock for this path only.
// Bulk ingest via consolidate.ts is unaffected.

const NEAR_DUPE_COSINE = 0.97;

let appendChain: Promise<unknown> = Promise.resolve();
function withAppendLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = appendChain.then(fn, fn);
  // Swallow errors on the chain so a failed call doesn't poison
  // subsequent ones; the error still propagates to the caller via `next`.
  appendChain = next.catch(() => undefined);
  return next;
}

export interface AppendFactInput {
  text: string;
  event_date?: string;     // YYYY-MM-DD; defaults to today
  source_session?: string; // free-form caller-supplied tag
  user_id?: string;
  run_id?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
}

export type AppendStatus = 'added' | 'duplicate';

export interface AppendFactResult {
  id: string;
  status: AppendStatus;
  reason?: 'hash' | 'cosine';
  similarity?: number;
}

export function appendSingleFact(
  input: AppendFactInput,
): Promise<AppendFactResult> {
  return withAppendLock(() => appendSingleFactImpl(input));
}

async function appendSingleFactImpl(
  input: AppendFactInput,
): Promise<AppendFactResult> {
  const text = input.text.trim();
  if (!text) {
    throw new Error('text must be non-empty');
  }

  const userId = input.user_id ?? 'default';
  const runId = input.run_id;
  const agentId = input.agent_id;

  const hash = createHash('md5').update(text).digest('hex');
  // Scope-bound dedup: an identical fact under (alice, none, none) does
  // not block writing the same text under (bob, none, none).
  const existing = await readFactsInScope({
    user_id: userId,
    run_id: runId,
    agent_id: agentId,
  });
  const hashHit = existing.find((f) => f.hash === hash);
  if (hashHit) {
    return { id: hashHit.id, status: 'duplicate', reason: 'hash' };
  }

  const embedding = await embedQuestion(text);

  let bestId: string | null = null;
  let bestSim = -1;
  for (const f of existing) {
    const sim = cosineSimilarity(embedding, f.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = f.id;
    }
  }
  if (bestId && bestSim >= NEAR_DUPE_COSINE) {
    return {
      id: bestId,
      status: 'duplicate',
      reason: 'cosine',
      similarity: bestSim,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const fact: Fact = {
    id: newFactId(),
    text,
    text_lemmatized: lemmatizeForBm25(text),
    user_id: userId,
    ...(runId !== undefined ? { run_id: runId } : {}),
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
    created_at: new Date().toISOString(),
    event_date: input.event_date ?? today,
    source_session: input.source_session ?? '',
    hash,
    embedding,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  await appendFacts([fact]);
  try {
    await upsertEntitiesFromFacts([fact]);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, factId: fact.id },
      'entity upsert failed for single-fact append',
    );
  }

  return { id: fact.id, status: 'added' };
}
