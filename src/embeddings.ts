import { cosineSimilarity } from 'ai';
import { embedQuestion, embedTexts } from './llm.js';
import { readFacts, type Fact } from './facts.js';
import { Bm25Index } from './bm25.js';
import {
  ENTITY_BOOST_WEIGHT,
  getBm25Params,
  normalizeBm25,
  scoreAndRank,
} from './scoring.js';
import { extractEntities, lemmatizeForBm25 } from './text.js';
import { readEntities, type Entity } from './entities.js';

// Re-export so callers (ingest, query) can import the embed helpers
// from a single module. Implementations live in llm.ts to avoid a
// circular dependency between embeddings.ts and entities.ts.
export { embedQuestion, embedTexts };

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

  // Step 6: entity boost — extract entities from query, embed each (max
  // 8, deduped), search the per-vault entity store, boost linked
  // memories. Mirrors mem0/memory/main.py:_compute_entity_boosts.
  const entityBoosts = await computeEntityBoosts(question);

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

// Verbatim port of mem0/memory/main.py:_compute_entity_boosts.
//
//   For each query entity (max 8, deduped):
//     1. Embed entity text
//     2. Cosine-search the entity store
//     3. For each match with sim >= 0.5, boost its linked_memory_ids by
//          sim * ENTITY_BOOST_WEIGHT * (1 / (1 + 0.001 * (n_linked - 1)^2))
//     4. Per-memory boost is the max across query entities.
//
// Returns Map<memory_id, boost in [0, ENTITY_BOOST_WEIGHT]>.
const ENTITY_SIM_THRESHOLD = 0.5;
const MAX_QUERY_ENTITIES = 8;

async function computeEntityBoosts(question: string): Promise<Map<string, number>> {
  const queryEntities = extractEntities(question);
  if (queryEntities.length === 0) return new Map();

  // Dedup by lower-cased text, take first MAX_QUERY_ENTITIES.
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const e of queryEntities) {
    const key = e.text.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(e.text);
    if (dedup.length >= MAX_QUERY_ENTITIES) break;
  }
  if (dedup.length === 0) return new Map();

  const store = await readEntities();
  if (store.length === 0) return new Map();

  let qEmbeddings: number[][];
  try {
    qEmbeddings = await embedTexts(dedup);
  } catch (err) {
    console.error(`[entities] query-entity embed failed: ${(err as Error).message}`);
    return new Map();
  }

  const boosts = new Map<string, number>();
  for (const qEmb of qEmbeddings) {
    for (const ent of store as Entity[]) {
      const sim = cosineSimilarity(qEmb, ent.embedding);
      if (sim < ENTITY_SIM_THRESHOLD) continue;
      const nLinked = Math.max(ent.linked_memory_ids.length, 1);
      const memoryCountWeight = 1.0 / (1.0 + 0.001 * (nLinked - 1) ** 2);
      const boost = sim * ENTITY_BOOST_WEIGHT * memoryCountWeight;
      for (const mid of ent.linked_memory_ids) {
        const cur = boosts.get(mid) ?? 0;
        if (boost > cur) boosts.set(mid, boost);
      }
    }
  }
  return boosts;
}
