import { embed, embedMany, cosineSimilarity } from 'ai';
import { getEmbeddingModel } from './llm.js';
import { readFacts, type Fact } from './facts.js';
import { Bm25Index } from './bm25.js';
import {
  ENTITY_BOOST_WEIGHT,
  getBm25Params,
  normalizeBm25,
  scoreAndRank,
} from './scoring.js';
import { lemmatizeForBm25 } from './text.js';

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

// Hybrid retrieval, port of mem0/memory/main.py:_search_vector_store.
//
//   semantic search → top max(k*4, 60) by cosine
//   BM25 search     → over lemmatized fact text
//   entity boost    → reserved for the entity-store layer (Phase 4b)
//   score_and_rank  → fuse via mem0's additive scoring, return top-K
//
// Lemmatization is computed lazily for facts that predate the hybrid
// layer (text_lemmatized field is optional on Fact).
const SEMANTIC_THRESHOLD = 0.1;

export const defaultFactRanker: FactRanker = async (question, k) => {
  const facts = await readFacts();
  if (facts.length === 0) return [];

  // Step 1: preprocess query
  const queryLemmatized = lemmatizeForBm25(question);

  // Step 2: embed query
  const qEmb = await embedQuestion(question);

  // Step 3: semantic search — over-fetch like mem0 (max(k*4, 60))
  const internalLimit = Math.max(k * 4, 60);
  const semanticAll = facts
    .map((f: Fact) => ({
      id: f.id,
      score: cosineSimilarity(qEmb, f.embedding),
      fact: f,
    }))
    .sort((a, b) => b.score - a.score);
  const semanticResults = semanticAll.slice(0, internalLimit);

  // Step 4: keyword search — BM25 over lemmatized text. Build the index
  // from the same internal-limit pool so BM25 only scores candidates the
  // semantic search surfaced (matches mem0's separate-keyword-search
  // shape closely enough at our scale).
  const bm25Docs = semanticResults.map(({ id, fact }) => ({
    id,
    lemmatized: fact.text_lemmatized ?? lemmatizeForBm25(fact.text),
  }));
  const bm25Index = new Bm25Index(bm25Docs);
  const bm25Hits = bm25Index.query(queryLemmatized);

  // Step 5: normalize BM25 with query-length-adaptive sigmoid params
  const [midpoint, steepness] = getBm25Params(question, queryLemmatized);
  const bm25Scores = new Map<string, number>();
  for (const h of bm25Hits) {
    if (h.score <= 0) continue;
    bm25Scores.set(h.id, normalizeBm25(h.score, midpoint, steepness));
  }

  // Step 6: entity boost — reserved for Phase 4b. Empty map until then.
  const entityBoosts = new Map<string, number>();
  void ENTITY_BOOST_WEIGHT; // referenced by score_and_rank's max_possible

  // Step 7-8: combine + rank
  const ranked = scoreAndRank(
    semanticResults.map(({ id, score }) => ({ id, score })),
    bm25Scores,
    entityBoosts,
    SEMANTIC_THRESHOLD,
    k,
  );

  const factById = new Map(facts.map((f) => [f.id, f]));
  return ranked
    .map((r) => factById.get(r.id))
    .filter((f): f is Fact => Boolean(f))
    .map((fact) => ({
      id: fact.id,
      text: fact.text,
      eventDate: fact.event_date,
      sourceSession: fact.source_session,
      createdAt: fact.created_at,
    }));
};
