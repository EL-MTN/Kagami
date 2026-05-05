import { cosineSimilarity } from "ai";
import { embedQuestion, embedTexts } from "../llm.js";
import { getDb } from "../storage/mongo.js";
import { ENTITY_BOOST_WEIGHT, getBm25Params, normalizeBm25, scoreAndRank } from "./scoring.js";
import { extractEntities, lemmatizeForBm25 } from "./text.js";
import { logger } from "../logger.js";

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

// Mem0-OSS-shaped filter shape. Scope fields and `category` are declared
// filter/token fields on the search/vector indexes and are pushed down at
// query time. `metadata` is dynamic (cannot be pre-declared) so it
// post-filters via $match after the candidate docs are fetched.
export interface MemoryFilters {
  user_id?: string;
  run_id?: string;
  agent_id?: string;
  category?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface RankerOptions {
  filters?: MemoryFilters;
}

export type FactRanker = (
  question: string,
  k: number,
  opts?: RankerOptions,
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
// can still enter the top-K.

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

export const defaultFactRanker: FactRanker = async (question, k, opts = {}) => {
  const db = await getDb();
  const facts = db.collection<FactRow>("facts");

  // Step 1: preprocess query.
  const queryLemmatized = lemmatizeForBm25(question);

  // Step 2: embed query.
  const qEmb = await embedQuestion(question);

  const internalLimit = Math.max(k * 4, 60);

  // Compile filters once. Scope/category are pushed down to the search
  // engines via declared filter fields. `metadata` keys are dynamic
  // (can't be pre-declared at index-build time) so they post-filter
  // through a $match stage after candidate docs are fetched.
  const vectorFilter = buildVectorSearchFilter(opts.filters);
  const searchFilter = buildSearchCompoundFilter(opts.filters);
  const metadataMatch = buildMetadataMatch(opts.filters);

  // Step 3: dense top-N via $vectorSearch. numCandidates is the HNSW
  // beam — Atlas docs recommend ~10x limit as a starting point.
  const dense = await facts
    .aggregate<{ _id: string }>([
      {
        $vectorSearch: {
          index: "facts_vec",
          path: "embedding",
          queryVector: qEmb,
          numCandidates: internalLimit * 10,
          limit: internalLimit,
          ...(vectorFilter ? { filter: vectorFilter } : {}),
        },
      },
      { $project: { _id: 1 } },
    ])
    .toArray();

  // Step 4: BM25 top-N via $search over the whole corpus (no
  // cosine prefilter — see file header for the recall rationale).
  const bm25Hits =
    queryLemmatized.length > 0
      ? await facts
          .aggregate<{ _id: string; bm25_raw: number }>([
            {
              $search: {
                index: "facts_text",
                ...(searchFilter
                  ? {
                      compound: {
                        must: [{ text: { query: queryLemmatized, path: "text_lemmatized" } }],
                        filter: searchFilter,
                      },
                    }
                  : {
                      text: { query: queryLemmatized, path: "text_lemmatized" },
                    }),
              },
            },
            { $limit: internalLimit },
            { $project: { _id: 1, bm25_raw: { $meta: "searchScore" } } },
          ])
          .toArray()
      : [];

  // Step 5: union the two candidate sets, then fetch full docs for the
  // union (we need the embedding to compute cosine in app, since
  // vectorSearchScore uses Atlas's (1+cos)/2 transform that doesn't
  // line up with the existing SEMANTIC_THRESHOLD=0.1 contract).
  // Metadata filters apply at this stage via the $match after $in.
  const ids = new Set<string>();
  for (const r of dense) ids.add(r._id);
  for (const r of bm25Hits) ids.add(r._id);
  if (ids.size === 0) return [];

  const fetchFilter: Record<string, unknown> = {
    _id: { $in: Array.from(ids) },
    ...(metadataMatch ?? {}),
  };
  const docs = await facts
    .find(fetchFilter)
    .project<FactRow>({
      text: 1,
      text_lemmatized: 1,
      event_date: 1,
      source_session: 1,
      created_at: 1,
      embedding: 1,
    })
    .toArray();

  // Step 6: cosine in app. Atlas's vectorSearchScore uses (1+cos)/2
  // which doesn't line up with SEMANTIC_THRESHOLD=0.1, so recompute.
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

  // Step 8: entity boost. The entity store itself isn't scoped (entities
  // are global by design), but the boost map is intersected with the
  // candidate-fact id set, so filters applied on the fact path implicitly
  // gate the boosts too.
  const entityBoosts = await computeEntityBoosts(question);

  // Step 9: combine + rank.
  const ranked = scoreAndRank(semanticResults, bm25Scores, entityBoosts, SEMANTIC_THRESHOLD, k);

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
  } catch (error) {
    logger.error({ error }, "query entity embed failed");
    return new Map();
  }

  const db = await getDb();
  const entities = db.collection<EntityRow>("entities");

  // Same cosine-recompute pattern as the fact path: $vectorSearch surfaces
  // candidates, but we recompute cosine in app so the threshold of 0.5
  // means raw cosine similarity.
  const boosts = new Map<string, number>();
  for (const qEmb of qEmbeddings) {
    const hits = await entities
      .aggregate<EntityRow>([
        {
          $vectorSearch: {
            index: "entities_vec",
            path: "embedding",
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

// MQL-shaped filter for $vectorSearch. Atlas evaluates this against
// fields declared as `type: filter` in the vector index. Only scope and
// category are pre-declared; metadata is dynamic and post-filters via
// buildMetadataMatch().
function buildVectorSearchFilter(filters?: MemoryFilters): Record<string, unknown> | undefined {
  if (!filters) return undefined;
  const clauses: Record<string, unknown> = {};
  if (filters.user_id !== undefined) clauses.user_id = { $eq: filters.user_id };
  if (filters.run_id !== undefined) clauses.run_id = { $eq: filters.run_id };
  if (filters.agent_id !== undefined) clauses.agent_id = { $eq: filters.agent_id };
  if (filters.category !== undefined) clauses.category = { $eq: filters.category };
  return Object.keys(clauses).length === 0 ? undefined : clauses;
}

// Atlas Search compound.filter clauses. `equals` requires the field to be
// mapped as `token` in the index — same scope+category set as the vector
// filter above.
function buildSearchCompoundFilter(
  filters?: MemoryFilters,
): Array<Record<string, unknown>> | undefined {
  if (!filters) return undefined;
  const clauses: Array<Record<string, unknown>> = [];
  if (filters.user_id !== undefined) {
    clauses.push({ equals: { path: "user_id", value: filters.user_id } });
  }
  if (filters.run_id !== undefined) {
    clauses.push({ equals: { path: "run_id", value: filters.run_id } });
  }
  if (filters.agent_id !== undefined) {
    clauses.push({ equals: { path: "agent_id", value: filters.agent_id } });
  }
  if (filters.category !== undefined) {
    clauses.push({ equals: { path: "category", value: filters.category } });
  }
  return clauses.length === 0 ? undefined : clauses;
}

// Mongo $match for arbitrary metadata.<key> filters. Applied after the
// candidate doc fetch, so it acts as a final gate on the union of the
// dense + lexical hits. Values are matched exactly via $eq.
function buildMetadataMatch(filters?: MemoryFilters): Record<string, unknown> | undefined {
  if (!filters?.metadata) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters.metadata)) {
    out[`metadata.${k}`] = { $eq: v };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
