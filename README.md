# Kioku

A personal long-term memory system. Atomic facts on disk + hybrid retrieval + a single MCP server interface.

Benchmarked at **76%** on a 100-item LongMemEval-Oracle subset with the full hybrid (cosine + BM25 + entity boost), on GPT-4o-mini answerer + judge. An earlier cosine + BM25-only configuration scored **78%** on the same subset.

**Head-to-head vs. mem0 OSS**: 76% / 76% on the same 100 question_ids, same models, mem0's v3 pipeline running its native top_k=200 vs. Kioku's top_k=50. Per-type the systems make different mistakes — mem0 is stronger on temporal-reasoning (88.3% vs. 81.7%), Kioku is stronger on multi-session (67.5% vs. 57.5%) — but the headline is a wash, suggesting the port is faithful. mem0's widely-cited "91% OSS" headline uses gpt-5 + full 500 questions; that operating point was not run here.

## Architecture

```
src/
  server.ts              express HTTP server (REST + streamable HTTP MCP)
  mcp.ts                 MCP tools mounted at /mcp
  llm.ts                 LLM provider (OpenAI-compatible) + embed helpers
  paths.ts               vault paths
  types.ts               shared schemas
  logger.ts              pino logger
  mutex.ts               process-wide async lock for vault writes
  ingest/
    consolidate.ts       transcript → atomic facts + entities
    append.ts            single-fact append (md5 + cosine dedup)
    sessions.ts          raw-string session ingest + summary fact
    transcript.ts        transcript parsing (raw/<session>.md)
  query/
    answer.ts            hybrid retrieval → single-shot answerer
    recall.ts            ranked retrieval, no LLM
  routes/                per-resource Express routers
  storage/
    mongo.ts             MongoClient singleton + getDb()
    indexes.ts           idempotent index setup (btree + $vectorSearch + $search)
    facts.ts             atomic facts collection (text + embedding + metadata)
    entities.ts          entities collection (text + embedding + linked_memory_ids)
  retrieval/
    embeddings.ts        hybrid ranker (cosine + BM25 + entity boost)
    bm25.ts              in-memory Okapi BM25
    scoring.ts           additive scoring fusion
    text.ts              lemmatization + entity extraction
prompts/
  extraction.md          ingest prompt (8K-token rulebook)
  answer.md              answerer prompt (3K-token rulebook)
```

### Storage layout

```
MongoDB (atlas-local, 127.0.0.1:27017)
  db: kioku
    facts        atomic facts: text + embedding + dates + md5 hash (unique)
    entities     entities: text + embedding + linked_memory_ids
    history      audit log of fact ADD/UPDATE/DELETE events
$KIOKU_VAULT/
  raw/<session>.md        immutable transcripts (input to ingest)
  .memory/
    llm-failures/         dropped LLM responses, for debugging
```

The migration from JSONL to MongoDB is in progress; see `plan.md`. Phase 1 (this commit) adds the connection layer and idempotent index setup but doesn't yet route reads/writes through Mongo.

### Pipeline

**Ingest** (`consolidate(transcriptPath)`):
1. Chunk the transcript into 2-message batches (one user + one assistant turn).
2. For each batch, look up the top-10 most-similar existing facts as dedup context.
3. Call the extraction prompt → get back `{memory: [{id, text}]}`.
4. md5-dedup each new fact against existing + within-batch hashes.
5. Embed and persist surviving facts to `facts.jsonl`.
6. Extract proper-noun and quoted-text entities from each new fact; upsert into `entities.jsonl` with linked fact ids.

**Query** (`query(question)`):
1. Embed and lemmatize the question.
2. Semantic search over `facts.jsonl` — over-fetch top `max(K*4, 60)` by cosine.
3. BM25 over the lemmatized text of those candidates.
4. Entity extraction on the question; for each query entity, search `entities.jsonl` and boost the linked facts.
5. Fuse the three signals via additive scoring: `(semantic + bm25 + entity_boost) / max_possible`, where `entity_boost ≤ 0.5` and `max_possible = 1 + (bm25 ? 1 : 0) + (entity ? 0.5 : 0)` adapts to which channels fired so the combined score stays in [0, 1]. Take top-K = 50.
6. Group surviving facts by date (newest-first), feed to the answerer prompt, strip `<mem_thinking>` block from output.

## Configuration

```sh
# .env
KIOKU_VAULT=/path/to/your/vault                # required (transcripts)
KIOKU_TOP_K=50                                 # optional, default 50

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

Then:

```sh
npm install
npm run typecheck
npm test

# Run as MCP server (stdio transport)
npm start

# Bench against LongMemEval — see bench/longmemeval/README.md
```

## MCP tools

| Tool | Purpose |
|---|---|
| `view` | Read a file or list a directory inside the vault |
| `create` | Create a new file (errors if it exists) |
| `str_replace` | Replace one occurrence of `old` with `new` in a vault file |
| `consolidate` | Extract atomic facts from a transcript into `facts.jsonl` |
| `query` | Answer a question using top-K hybrid retrieval |
| `fact_count` | Return the number of atomic facts currently stored |

## Design notes

- **No vector DB.** facts.jsonl + in-memory cosine. Fast through ~10K facts per vault; swap in qdrant if you scale past that.
- **Embeddings persisted at write time.** Query is one embed call + cosine + BM25 + entity boost — no re-embedding.
- **Transcripts are immutable.** `raw/<session>.md` files are the audit trail; facts are derived.
- **Atomic facts are write-once.** No UPDATE/DELETE — corrections happen by appending a newer fact with a later `event_date`; the answerer prompt resolves conflicts newest-wins (`prompts/answer.md`).

The architecture is closely modeled on the open-source memory benchmarks at [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks). Implementation is independent (pure TypeScript, no spaCy / qdrant / Docker) but the prompts, scoring formulas, and pipeline shape come from there.
