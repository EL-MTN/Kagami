import { cosineSimilarity } from 'ai';
import { embedQuestion, embedTexts } from '../llm.js';
import { getDb } from '../storage/mongo.js';
import {
  ENTITY_BOOST_WEIGHT,
  getBm25Params,
  normalizeBm25,
  scoreAndRank,
} from './scoring.js';
import { extractEntities, lemmatizeForBm25 } from './text.js';

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

// Kioku's hybrid fact retrieval. Three signals fused into one rank:
//
//   $vectorSearch  → top max(k*4, 60) by cosine over fact embeddings
//   $search (BM25) → top max(k*4, 60) by lexical match over text_lemmatized
//   entity boost   → query entities matched against the entity store
//   scoreAndRank   → additive fusion, return top-K
//
// The two search passes run independently against the whole corpus, so
// a fact that's weak on cosine but strong on keyword (or vice versa)
// can still enter the top-K — this is the recall ceiling Kioku-on-JSONL
// hit, where BM25 only saw the cosine-prefiltered window.

const SEMANTIC_THRESHOLD = 0.1;
const ENTITY_SIM_THRESHOLD = 0.5;
const MAX_QUERY_ENTITIES = 8;
const ENTITY_VS_NUM_CANDIDATES = 100;
const ENTITY_VS_LIMIT = 20;

interface FactRow {
  _id: string;
  text: string;
  text_lemmatized?: string;
  event_date: string;
  source_session: string;
  created_at: string;
  embedding: number[];
}

interface EntityRow {
  _id: string;
  embedding: number[];
  linked_memory_ids: string[];
}

export const defaultFactRanker: FactRanker = async (question, k) => {
  const db = await getDb();
  const facts = db.collection<FactRow>('facts');

  // Step 1: preprocess query.
  const queryLemmatized = lemmatizeForBm25(question);

  // Step 2: embed query.
  const qEmb = await embedQuestion(question);

  const internalLimit = Math.max(k * 4, 60);

  // Step 3: dense top-N via $vectorSearch. numCandidates is the HNSW
  // beam — Atlas docs recommend ~10x limit as a starting point.
  const dense = await facts
    .aggregate<{ _id: string }>([
      {
        $vectorSearch: {
          index: 'facts_vec',
          path: 'embedding',
          queryVector: qEmb,
          numCandidates: internalLimit * 10,
          limit: internalLimit,
        },
      },
      { $project: { _id: 1 } },
    ])
    .toArray();

  // Step 4: BM25 top-N via $search over the whole corpus. Whole-corpus
  // is the deliberate behavior change vs JSONL Kioku, where BM25 was
  // restricted to the cosine-prefiltered window.
  const bm25Hits =
    queryLemmatized.length > 0
      ? await facts
          .aggregate<{ _id: string; bm25_raw: number }>([
            {
              $search: {
                index: 'facts_text',
                text: { query: queryLemmatized, path: 'text_lemmatized' },
              },
            },
            { $limit: internalLimit },
            { $project: { _id: 1, bm25_raw: { $meta: 'searchScore' } } },
          ])
          .toArray()
      : [];

  // Step 5: union the two candidate sets, then fetch full docs for the
  // union (we need the embedding to compute cosine in app, since
  // vectorSearchScore uses Atlas's (1+cos)/2 transform that doesn't
  // line up with the existing SEMANTIC_THRESHOLD=0.1 contract).
  const ids = new Set<string>();
  for (const r of dense) ids.add(r._id);
  for (const r of bm25Hits) ids.add(r._id);
  if (ids.size === 0) return [];

  const docs = (await facts
    .find({ _id: { $in: Array.from(ids) } })
    .project<FactRow>({
      text: 1,
      text_lemmatized: 1,
      event_date: 1,
      source_session: 1,
      created_at: 1,
      embedding: 1,
    })
    .toArray());

  // Step 6: cosine in app. Preserves the existing scoring math exactly
  // — same threshold, same units as the JSONL implementation.
  const semanticResults = docs.map((d) => ({
    id: d._id,
    score: cosineSimilarity(qEmb, d.embedding),
  }));

  // Step 7: normalize BM25 with query-length-adaptive sigmoid params.
  const [midpoint, steepness] = getBm25Params(question, queryLemmatized);
  const bm25Scores = new Map<string, number>();
  for (const h of bm25Hits) {
    if (h.bm25_raw <= 0) continue;
    bm25Scores.set(h._id, normalizeBm25(h.bm25_raw, midpoint, steepness));
  }

  // Step 8: entity boost.
  const entityBoosts = await computeEntityBoosts(question);

  // Step 9: combine + rank.
  const ranked = scoreAndRank(
    semanticResults,
    bm25Scores,
    entityBoosts,
    SEMANTIC_THRESHOLD,
    k,
  );

  const docById = new Map(docs.map((d) => [d._id, d]));
  return ranked
    .map((r) => docById.get(r.id))
    .filter((d): d is FactRow => Boolean(d))
    .map((d) => ({
      id: d._id,
      text: d.text,
      eventDate: d.event_date,
      sourceSession: d.source_session,
      createdAt: d.created_at,
    }));
};

// Per-fact entity boost.
//
//   For each query entity (max 8, deduped):
//     1. Embed entity text
//     2. $vectorSearch over the entity store
//     3. For each match with sim >= 0.5, boost its linked_memory_ids by
//          sim * ENTITY_BOOST_WEIGHT * (1 / (1 + 0.001 * (n_linked - 1)^2))
//     4. Per-memory boost is the max across query entities.
//
// Returns Map<memory_id, boost in [0, ENTITY_BOOST_WEIGHT]>.
async function computeEntityBoosts(question: string): Promise<Map<string, number>> {
  const queryEntities = extractEntities(question);
  if (queryEntities.length === 0) return new Map();

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

  let qEmbeddings: number[][];
  try {
    qEmbeddings = await embedTexts(dedup);
  } catch (err) {
    console.error(`[entities] query-entity embed failed: ${(err as Error).message}`);
    return new Map();
  }

  const db = await getDb();
  const entities = db.collection<EntityRow>('entities');

  // Same cosine-recompute pattern as the fact path: $vectorSearch surfaces
  // candidates, but we recompute cosine in app so the threshold of 0.5
  // means raw cosine similarity (matching the JSONL implementation).
  const boosts = new Map<string, number>();
  for (const qEmb of qEmbeddings) {
    const hits = await entities
      .aggregate<EntityRow>([
        {
          $vectorSearch: {
            index: 'entities_vec',
            path: 'embedding',
            queryVector: qEmb,
            numCandidates: ENTITY_VS_NUM_CANDIDATES,
            limit: ENTITY_VS_LIMIT,
          },
        },
        { $project: { embedding: 1, linked_memory_ids: 1 } },
      ])
      .toArray();
    for (const ent of hits) {
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
