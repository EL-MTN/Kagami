import { embed, embedMany, cosineSimilarity } from 'ai';
import { getEmbeddingModel } from './llm.js';
import { readFacts, type Fact } from './facts.js';

// Embedding helpers used by the ingest pipeline (per-batch dedup-context
// lookup against existing facts) and by query (top-K fact retrieval).

export async function embedQuestion(q: string): Promise<number[]> {
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value: q,
    abortSignal: AbortSignal.timeout(5_000),
  });
  return embedding;
}

export async function embedTexts(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedMany({
    model: getEmbeddingModel(),
    values: texts,
    maxParallelCalls: 8,
    abortSignal: AbortSignal.timeout(15_000),
  });
  return embeddings;
}

export interface RankedFact {
  id: string;
  text: string;
  eventDate: string;
  sourceSession: string;
  createdAt: string;
}

export type FactRanker = (
  question: string,
  k: number,
) => Promise<RankedFact[]>;

export const defaultFactRanker: FactRanker = async (question, k) => {
  const facts = await readFacts();
  if (facts.length === 0) return [];
  const qEmb = await embedQuestion(question);
  const scored = facts.map((f: Fact) => ({
    fact: f,
    sim: cosineSimilarity(qEmb, f.embedding),
  }));
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k).map(({ fact }) => ({
    id: fact.id,
    text: fact.text,
    eventDate: fact.event_date,
    sourceSession: fact.source_session,
    createdAt: fact.created_at,
  }));
};
