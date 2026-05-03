import { createHash } from 'node:crypto';
import { cosineSimilarity } from 'ai';
import { embedQuestion } from '../llm.js';
import { lemmatizeForBm25 } from '../retrieval/text.js';
import {
  appendFacts,
  newFactId,
  readFacts,
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
// Caller is expected to hold the vault mutex.

const NEAR_DUPE_COSINE = 0.97;

export interface AppendFactInput {
  text: string;
  event_date?: string;     // YYYY-MM-DD; defaults to today
  source_session?: string; // free-form caller-supplied tag
  user_id?: string;
}

export type AppendStatus = 'added' | 'duplicate';

export interface AppendFactResult {
  id: string;
  status: AppendStatus;
  reason?: 'hash' | 'cosine';
  similarity?: number;
}

export async function appendSingleFact(
  input: AppendFactInput,
): Promise<AppendFactResult> {
  const text = input.text.trim();
  if (!text) {
    throw new Error('text must be non-empty');
  }

  const hash = createHash('md5').update(text).digest('hex');
  const existing = await readFacts();
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
    user_id: input.user_id ?? 'default',
    created_at: new Date().toISOString(),
    event_date: input.event_date ?? today,
    source_session: input.source_session ?? '',
    hash,
    embedding,
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
