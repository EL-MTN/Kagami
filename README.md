# Kioku

A personal long-term memory system. Atomic facts in MongoDB + hybrid retrieval (`$vectorSearch` + `$search` + entity boost) + a single MCP server interface.

Benchmarked at **78%** on a 100-item LongMemEval-Oracle subset (gpt-4o-mini answerer + judge, lmstudio nomic embeddings, atlas-local). Up from the JSONL-era baseline of 76% — the gain comes from whole-corpus BM25 closing the recall ceiling on multi-session questions (72.5% vs. 67.5%); temporal-reasoning is unchanged at 81.7%.

**Head-to-head vs. mem0 OSS** (JSONL-era numbers, pre-Mongo): 76% / 76% on the same 100 question_ids, same models, mem0's v3 pipeline running its native top_k=200 vs. Kioku's top_k=50. mem0's widely-cited "91% OSS" headline uses gpt-5 + full 500 questions; that operating point was not run here.

## Architecture

The repo is a turborepo with two apps: `apps/api` (Express + MCP, the memory subsystem itself) and `apps/dashboard` (a Next.js inspector at `kioku.localhost`).

```
apps/api/src/
  server.ts              express HTTP server (REST + streamable HTTP MCP)
  mcp.ts                 MCP tools mounted at /mcp
  llm.ts                 LLM provider (OpenAI-compatible) + embed helpers
  paths.ts               prompts directory
  types.ts               shared schemas
  logger.ts              pino logger
  ingest/
    consolidate.ts       transcript → atomic facts + entities
    append.ts            single-fact append (md5 + cosine dedup)
    sessions.ts          raw-string session ingest + summary fact
    session-summary.ts   cached narrative summary fed into extraction
    transcript.ts        transcript parsing (frontmatter + turn headings)
  query/
    answer.ts            hybrid retrieval → single-shot answerer
    recall.ts            ranked retrieval, no LLM
  routes/                per-resource Express routers
  storage/
    mongo.ts             MongoClient singleton + getDb()
    indexes.ts           idempotent index setup (btree + $vectorSearch + $search)
    facts.ts             atomic facts collection (text + embedding + metadata)
    entities.ts          entities collection (text + embedding + linked_memory_ids)
    transcripts.ts       parsed transcripts (source-of-truth for ingest)
    history.ts           audit log of fact ADD/UPDATE/DELETE events
  retrieval/
    embeddings.ts        hybrid ranker (cosine + BM25 + entity boost)
    scoring.ts           additive scoring fusion
    text.ts              lemmatization + entity extraction
apps/api/prompts/
  extraction.md          ingest prompt (8K-token rulebook)
  answer.md              answerer prompt (3K-token rulebook)
```

### Storage layout

```
MongoDB (atlas-local, 127.0.0.1:27017)
  db: kioku
    facts               atomic facts: text + embedding + dates + md5 hash (unique)
                        indexes: facts_vec ($vectorSearch), facts_text ($search)
    entities            entities: text + embedding + linked_memory_ids
                        indexes: entities_vec ($vectorSearch), text_lower (unique)
    transcripts         parsed session transcripts (source-of-truth for ingest)
    session_summaries   cached narrative summaries, keyed by source_session
    history             audit log of fact ADD/UPDATE/DELETE events
```

State lives entirely in Mongo — no filesystem-backed vault.

### Pipeline

**Ingest** (`consolidate(transcript)`):
1. Chunk the transcript into 2-message batches (one user + one assistant turn).
2. For each batch, look up the top-10 most-similar existing facts as dedup context.
3. Call the extraction prompt → get back `{memory: [{id, text}]}`.
4. md5-dedup each new fact against existing + within-batch hashes.
5. Embed and `insertMany` surviving facts; the `facts_hash_unique` index handles dedup atomically.
6. Extract proper-noun and quoted-text entities from each new fact; per-entity `updateOne` with `$setOnInsert` + `$addToSet` on `linked_memory_ids` (race-safe under concurrent ingest).

**Query** (`query(question)`):
1. Embed and lemmatize the question.
2. `$vectorSearch` on `facts_vec` — top `max(K*4, 60)` by cosine.
3. `$search` BM25 on `facts_text` (whole-corpus) — top `max(K*4, 60)` by lexical match. Whole-corpus instead of cosine-prefiltered closes the recall ceiling: a fact strong on keywords but weak on cosine can still enter the top-K.
4. Union the candidate _id sets, fetch full docs, recompute cosine in app to preserve the existing scoring math.
5. Entity extraction on the question; for each query entity, `$vectorSearch` on `entities_vec` and boost the linked facts.
6. Fuse the three signals via additive scoring: `(semantic + bm25 + entity_boost) / max_possible`, where `entity_boost ≤ 0.5` and `max_possible = 1 + (bm25 ? 1 : 0) + (entity ? 0.5 : 0)` adapts to which channels fired so the combined score stays in [0, 1]. Take top-K = 50.
7. Group surviving facts by date (newest-first), feed to the answerer prompt, strip `<mem_thinking>` block from output.

## Configuration

API config lives at `apps/api/.env` (copy `apps/api/.env.example` to start).

```sh
# apps/api/.env
KIOKU_TOP_K=50                                    # optional, default 50

# MongoDB (defaults to local atlas-local on 27017). The vector index dim
# is probed from the embedding provider at startup, so no env var needed.
# KIOKU_MONGO_URI=mongodb://127.0.0.1:27017/?directConnection=true
# KIOKU_MONGO_DB=kioku

# Chat / answerer
LLM_PROVIDER=lmstudio                             # 'lmstudio' or 'openai'
MODEL=zai-org/glm-4.7-flash                       # provider-native model id
# LLM_URL=http://localhost:1234/v1                # override (defaults from profile)
# LLM_API_KEY=lm-studio                           # override (defaults from profile)

# Embeddings — independent provider; can mix-and-match
EMBEDDING_PROVIDER=lmstudio                       # 'lmstudio' or 'openai'
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
# EMBEDDING_URL=...                               # override
# EMBEDDING_API_KEY=...                           # override

# Used as the *_API_KEY default when *_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

Provider profiles supply URL+key defaults so a typical setup is one line per role. Any OpenAI-compatible endpoint works (LM Studio, OpenAI, vLLM, Ollama, etc.) by setting the explicit `*_URL`/`*_API_KEY` overrides. The provider abstraction is `@ai-sdk/openai-compatible`.

Common combinations:
- **All-local**: `LLM_PROVIDER=lmstudio`, `EMBEDDING_PROVIDER=lmstudio`, `MODEL=<your-loaded-model>`.
- **All-OpenAI**: `LLM_PROVIDER=openai`, `EMBEDDING_PROVIDER=openai`, `MODEL=gpt-4o-mini`, `EMBEDDING_MODEL=text-embedding-3-small`, `OPENAI_API_KEY=sk-...`.
- **Hybrid (cheap chat, free embed)**: `LLM_PROVIDER=openai` + `MODEL=gpt-4o-mini` for the answerer; `EMBEDDING_PROVIDER=lmstudio` + `EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5` for the embeddings.

## Usage

Prerequisites: a local MongoDB Atlas Search instance on `127.0.0.1:27017`. The simplest path is the `mongodb-atlas-local` container:

```sh
atlas local start mongodb
# or:
docker run -d -p 27017:27017 mongodb/mongodb-atlas-local
```

Then, from the repo root:

```sh
npm install
npm run typecheck
npm test

# Run both apps under portless (https://kioku.localhost + https://api.kioku.localhost)
npm run dev

# Or just one of them
npm run dev:api
npm run dev:dashboard

# Bench against LongMemEval — see apps/api/bench/longmemeval/README.md
```

The MCP surface is mounted at `/mcp` on the API server (streamable HTTP transport).

## MCP tools

| Tool | Purpose |
|---|---|
| `ingest_session` | Extract facts from a raw transcript string + write a session-summary fact |
| `append_fact` | Add one fact verbatim (no LLM). Accepts scope + metadata + category |
| `append_facts` | Bulk infer=false add (mem0-OSS-style). Up to 500 facts in one call |
| `recall` | Hybrid retrieval (no LLM). Accepts scope/metadata/category filters |
| `query` | Answer a question using top-K hybrid retrieval. Accepts the same filters |
| `fact_count` | Return the number of atomic facts currently stored |
| `fact_history` | Return the audit journal (ADD/UPDATE/DELETE) for one fact |

## Design notes

- **One Mongo, all collections.** `facts`, `entities`, `transcripts`, `session_summaries`, `history` — a single `mongodb-atlas-local` container handles dense vector search, BM25, the audit log, and the source-of-truth for ingest. Replaces what mem0 splits across Qdrant + SQLite, and what an earlier version of Kioku split across Mongo + the filesystem.
- **Embeddings persisted at write time.** Query is one embed call; the dense pre-pass uses `$vectorSearch` (HNSW), with cosine recomputed in app over the candidate union to preserve the existing scoring contract.
- **Whole-corpus BM25.** `$search` runs against the whole corpus rather than a cosine-prefiltered window, so a fact strong on keywords but weak on cosine can still surface. The sigmoid that normalizes raw BM25 into the additive fusion is calibrated against Lucene's score range — see `scripts/probe-bm25-scores.ts` for the refit tool.
- **Transcripts are immutable.** Persisted in the `transcripts` collection on first ingest; facts are derived. Re-ingest of the same `sessionId` is a no-op (hash dedup short-circuits the writes).
- **Atomic facts are write-once.** No UPDATE/DELETE — corrections happen by appending a newer fact with a later `event_date`; the answerer prompt resolves conflicts newest-wins (`prompts/answer.md`). Every mutation leaves a row in the `history` collection for postmortem.

The architecture is closely modeled on the open-source memory benchmarks at [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks). Implementation is independent (pure TypeScript, no spaCy / Qdrant) but the prompts, scoring formulas, and pipeline shape come from there.
