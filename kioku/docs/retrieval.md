# Retrieval

Hybrid retrieval ranks the `facts` collection by fusing three signals — cosine over fact embeddings, BM25 over lemmatized text, and an entity boost from the `entities` collection. The output feeds two read paths: `recall` (ranked facts, no LLM) and `query` (single-shot answerer).

## Layout

```
apps/api/src/retrieval/
├── embeddings.ts   # defaultFactRanker — orchestrates all three signals
├── scoring.ts      # additive fusion + BM25 sigmoid normalization
└── text.ts         # lemmatizeForBm25 + extractEntities
```

`apps/api/src/llm.ts` exposes `embedQuestion(q)` and `embedTexts(texts)`. They're re-exported from `embeddings.ts` so callers (ingest, query) can import everything from a single module — the implementations live in `llm.ts` to avoid a circular dep with `entities.ts`.

## Hybrid ranker (`embeddings.ts`)

`defaultFactRanker(question, k, opts)` returns the top-K `RankedFact[]`. Constants:

| Constant                   | Value          | Purpose                                                              |
| -------------------------- | -------------- | -------------------------------------------------------------------- |
| `SEMANTIC_THRESHOLD`       | 0.1            | Drop candidates whose cosine score is below this gate before fusion. |
| `ENTITY_SIM_THRESHOLD`     | 0.5            | Entity-store hits below this similarity contribute no boost.         |
| `MAX_QUERY_ENTITIES`       | 8              | Cap on deduped entities embedded from the question.                  |
| `ENTITY_VS_NUM_CANDIDATES` | 100            | HNSW beam for `$vectorSearch` over the entity store.                 |
| `ENTITY_VS_LIMIT`          | 20             | Per-entity cap on entity-store hits considered for boosts.           |
| `internalLimit`            | `max(k*4, 60)` | Per-channel candidate cap before fusion.                             |

### The pipeline

```
1. queryLemmatized = lemmatizeForBm25(question)
2. qEmb = embedQuestion(question)
3. Compile filters (vector / search / metadata) from MemoryFilters
4. dense ← $vectorSearch on facts_vec, numCandidates = internalLimit*10, limit = internalLimit
5. bm25Hits ← $search on facts_text (whole corpus), limit = internalLimit, with searchScore meta
6. ids = union(dense.ids, bm25.ids); fetch full docs by $in (with metadata $match)
7. semanticResults ← cosineSimilarity(qEmb, doc.embedding) recomputed in app
8. [midpoint, steepness] = getBm25Params(question, queryLemmatized)
   normalize each bm25_raw → [0, 1]
9. entityBoosts = computeEntityBoosts(question)
10. ranked = scoreAndRank(semanticResults, bm25Scores, entityBoosts, threshold=0.1, k)
11. return docs in ranked order, projected to RankedFact
```

**Why recompute cosine in app?** Atlas's `vectorSearchScore` uses `(1 + cos) / 2`, which would shift the meaning of `SEMANTIC_THRESHOLD = 0.1`. The candidate union is small (≤ 2 × `internalLimit`), so the recompute is cheap relative to the round-trip and lets us preserve the existing scoring contract.

**Why whole-corpus BM25?** A cosine-prefilter would let strong-keyword / weak-cosine facts disappear before the BM25 pass even sees them. Running `$search` independently against the whole corpus closes the recall ceiling on multi-session questions (and is the source of the JSONL-era → Mongo-era benchmark gain).

### Filters

Two zod-shaped filter sources, both flowing into `MemoryFilters`:

```ts
interface MemoryFilters {
  user_id?: string;
  run_id?: string;
  agent_id?: string;
  category?: string;
  metadata?: Record<string, string | number | boolean>;
}
```

Pushed down where the search engines support it:

| Field        | Vector index (`facts_vec`)                      | Search index (`facts_text`)                            |
| ------------ | ----------------------------------------------- | ------------------------------------------------------ |
| `user_id`    | `type: filter` → `$vectorSearch.filter.user_id` | `type: token` → `compound.filter.equals.path: user_id` |
| `run_id`     | `type: filter`                                  | `type: token`                                          |
| `agent_id`   | `type: filter`                                  | `type: token`                                          |
| `category`   | `type: filter`                                  | `type: token`                                          |
| `metadata.*` | (dynamic — not pre-declared)                    | (dynamic — not pre-declared)                           |

Dynamic `metadata.<key>` filters apply post-vector-search, in the `$match` stage that runs after `$in` on the union. Values match exactly via `$eq`; only flat string/number/boolean metadata is filterable.

### Entity boosts (`computeEntityBoosts`)

```
1. queryEntities = extractEntities(question)
2. dedup case-insensitive, cap at 8, drop empties
3. embedTexts(deduped)
4. for each query entity:
     hits ← $vectorSearch on entities_vec (numCandidates=100, limit=20)
     for each hit:
       sim = cosineSimilarity(qEmb, hit.embedding)         ← recomputed in app
       if sim < 0.5: continue
       memoryCountWeight = 1 / (1 + 0.001 * (n_linked - 1)^2)
       boost = sim * 0.5 * memoryCountWeight                ← ENTITY_BOOST_WEIGHT = 0.5
       for each linked_memory_id:
         boosts[mid] = max(boosts[mid], boost)
5. return Map<memory_id, boost in [0, 0.5]>
```

The entity store is **not scoped** by `(user_id, run_id, agent_id)` — entities are global by design. The boost map is intersected with the candidate-fact id set in `scoreAndRank`, so any scope filters applied on the fact path implicitly gate the boosts too.

`memoryCountWeight` attenuates entities that link to many facts: a celebrity-entity linked to 100 facts should raise the score of any one of them less than a unique-named entity linked to 2 facts. The 0.001 coefficient is empirical.

## Scoring (`scoring.ts`)

Three signals, each in `[0, 1]`, fused additively:

```
ENTITY_BOOST_WEIGHT = 0.5
maxPossible = 1.0 + (hasBm25 ? 1.0 : 0) + (hasEntity ? 0.5 : 0)

for each candidate r in semanticResults:
  if r.score < threshold: drop
  raw = r.score + (bm25Scores[r.id] ?? 0) + (entityBoosts[r.id] ?? 0)
  score = min(raw / maxPossible, 1.0)

sort desc, take top K.
```

`maxPossible` adapts so the combined score stays in `[0, 1]` regardless of which channels fired — a query with zero matched entities and zero BM25 hits still gets a normalized 0–1 score from cosine alone.

### BM25 sigmoid (`getBm25Params` + `normalizeBm25`)

Atlas's `$search` returns Lucene-shaped raw scores, typically in the 1–8 range on Kioku-scale corpora. `LUCENE-8563` (2018) dropped the `(k1+1)` numerator factor so per-term contributions are ~2.4× smaller than older Okapi BM25 references. Small per-vault corpora compress further via reduced IDF.

`normalizeBm25(raw, midpoint, steepness) = 1 / (1 + exp(-steepness * (raw - midpoint)))` — a logistic sigmoid. Parameters are query-length-adaptive and can be overridden with env vars:

| Token count (lemmatized) | Midpoint env                 | Default | Steepness env                 | Default |
| ------------------------ | ---------------------------- | ------- | ----------------------------- | ------- |
| ≤ 3                      | `BM25_SIGMOID_MIDPOINT_3`    | `1.5`   | `BM25_SIGMOID_STEEPNESS_3`    | `1.5`   |
| ≤ 6                      | `BM25_SIGMOID_MIDPOINT_6`    | `2.0`   | `BM25_SIGMOID_STEEPNESS_6`    | `1.0`   |
| ≤ 9                      | `BM25_SIGMOID_MIDPOINT_9`    | `2.5`   | `BM25_SIGMOID_STEEPNESS_9`    | `1.2`   |
| ≤ 15                     | `BM25_SIGMOID_MIDPOINT_15`   | `3.0`   | `BM25_SIGMOID_STEEPNESS_15`   | `1.0`   |
| > 15                     | `BM25_SIGMOID_MIDPOINT_GT15` | `3.5`   | `BM25_SIGMOID_STEEPNESS_GT15` | `1.0`   |

Midpoints must be finite non-negative numbers; steepness values must be finite positive numbers. Kioku logs the resolved table once at API boot.

Calibrated empirically on a 20-item LongMemEval-Oracle slice so:

- top-relevant docs (max raw) → ≥ 0.85 normalized
- p75 docs → 0.5–0.7
- irrelevant tail → < 0.15

Refit after embedding-model or corpus-shape changes via `apps/api/scripts/probe-bm25-scores.ts` — a one-shot diagnostic that ingests a slice of LongMemEval items, captures raw `$search` scores, and emits a bucketed distribution summary. See [bench.md](bench.md).

## Text utilities (`text.ts`)

Two pure functions used by both ingest (write-time) and retrieval (query-time).

### `lemmatizeForBm25(text)`

Collapses surface variation so BM25 keyword matching catches `attending` / `attended` / `attends` as the same term. Algorithm:

1. Lowercase and tokenize on `[a-z0-9]+`.
2. Drop English stopwords (`STOPWORDS` set — ~70 entries).
3. Apply Porter-lite suffix reduction (`stem`):
   - `sses` → `ss` (`classes` → `class`)
   - `ies` → `y` for words > 4 chars (`berries` → `berry`)
   - `s` → `""` (skipping `ss`, `us`)
   - `ing` → `""` for words > 5 chars
   - `ed` → `""` for words > 4 chars
   - `ly` → `""` for words > 4 chars
4. Preserve the original `-ing` form alongside the stem so noun uses (`meeting` the noun) still match document occurrences without POS tagging.

Lossier than a proper Porter stemmer on irregular forms; fine for keyword matching, and the same analyzer is applied at write time and query time so tokens line up exactly.

The Atlas Search index `facts_text` uses `lucene.whitespace` on `text_lemmatized` — no re-stemming, no re-lowercasing — because the JS lemmatizer already did all of that.

### `extractEntities(text)`

Two cheap-to-detect entity shapes:

- **PROPER**: `/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)\b/g` — runs of capitalized words. Filters: skip `_GENERIC_CAPS` set (`User`, `Assistant`, weekday + month names, generic plurals like `things`, `tips`); single-word entities must be ≥ 4 chars to filter out sentence-start false positives.
- **QUOTED**: `/"([^"\n]+)"|'([^'\n]+)'/g` — text inside single or double quotes. Capped at 100 chars.

Output is deduped by `<type>:<lower>` key. Lossier than spaCy NER but cheap, deterministic, and dependency-free. The entity-boost ranker calls this on the question; ingest calls it on every new fact (via `upsertEntitiesFromFacts`).

## What's pluggable / what isn't

Pluggable:

- LLM provider (any OpenAI-compatible endpoint via `LLM_*` env vars)
- Embedding provider (independent `EMBEDDING_*` env vars)
- Embedding dimension (probed at startup; index drift detection raises a pointed error if `EMBEDDING_MODEL` changed)

Not pluggable today:

- Lemmatizer (Porter-lite — no spaCy / NLTK dep)
- Entity extractor (regex-based — no NER model)
- BM25 sigmoid parameter buckets (env-tunable; refit via the probe script)
- Three-channel additive fusion (cosine + BM25 + entity boost)
- `SEMANTIC_THRESHOLD = 0.1`, `ENTITY_BOOST_WEIGHT = 0.5`

If you swap the embedding model, the index drift check at startup will detect the dimension change and tell you to drop the vector index. Re-tuning the BM25 sigmoid is optional but recommended after large corpus-shape changes.
