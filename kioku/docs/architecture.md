# Architecture

## System Overview

Kioku is a long-term memory subsystem for an agentic assistant. It accepts conversation transcripts, extracts atomic facts from them, embeds the facts, and serves them back via hybrid retrieval (cosine + BM25 + entity boost). External agents (Kokoro is the primary client) consume the service over HTTP REST or MCP.

### Monorepo Layout

```
kioku/                              # subtree of the Kagami nested monorepo
├── apps/                           # (npm workspaces + Turborepo are owned by the Kagami root)
│   ├── api/                        # Express HTTP server + MCP transport
│   │   ├── src/
│   │   │   ├── server.ts           # bootstrap: ensureIndexes → app.listen → graceful shutdown
│   │   │   ├── mcp.ts              # streamable-HTTP MCP transport mounted at /mcp
│   │   │   ├── llm.ts              # env resolution (canonical + legacy shim) + @kagami/llm createInference wiring + embed helpers
│   │   │   ├── paths.ts            # prompts directory pointer
│   │   │   ├── types.ts            # Transcript / Turn zod schemas
│   │   │   ├── logger.ts           # pino logger
│   │   │   ├── ingest/             # transcript → atomic facts (consolidate, append, sessions, summary, parser)
│   │   │   ├── query/              # answer.ts (LLM answerer) + recall.ts (no-LLM ranked retrieval)
│   │   │   ├── retrieval/          # hybrid ranker, scoring, lemmatizer + entity extractor
│   │   │   ├── routes/             # per-resource Express routers + shared filter zod schema
│   │   │   └── storage/            # mongo singleton, idempotent indexes, facts/entities/transcripts/history
│   │   ├── tsconfig.json           # extends @kagami/tsconfig/server.json
│   │   ├── tsconfig.build.json     # prod build: tsc -p this → dist/ (extends @kagami/tsconfig/server.build.json)
│   │   ├── eslint.config.js        # imports from @kagami/eslint-config/base
│   │   ├── prompts/                # extraction.md (8K) + answer.md (3K)
│   │   ├── tests/                  # vitest + mongodb-memory-server
│   │   ├── scripts/                # bench worker, BM25 probe
│   │   └── bench/longmemeval/      # benchmark harness + datasets + results
│   └── dashboard/                  # Next.js 15 inspector (https://kioku.localhost)
│       ├── tsconfig.json           # extends @kagami/tsconfig/nextjs.json
│       └── eslint.config.js        # imports from @kagami/eslint-config/base
├── portless.json                   # Portless app registrations
└── docs/
```

Workspace-shared packages — `@kagami/eslint-config`, `@kagami/tsconfig` (tooling) and the `@kagami/llm` runtime inference gateway — live at the Kagami workspace root under `shared/packages/`; Kioku has no project-internal TS packages.

### Dependency Graph

```
@kagami/eslint-config, @kagami/tsconfig, @kagami/llm (workspace-shared, from shared/packages/)
       ↑
@kioku/api          ← Express, MCP, ingest + retrieval pipelines
@kioku/dashboard    ← Next.js inspector — talks to API only over HTTP
```

The two apps share **no in-process code**. The dashboard's contract with the API is the REST surface in `apps/api/src/routes/*`, hit through `fetch` to `KIOKU_API_URL` (default `https://api.kioku.localhost`).

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                      External clients                             │
│  Kokoro bot · Claude Desktop / agents · Dashboard · CLI scripts   │
└────────────────┬───────────────────────────────────┬──────────────┘
                 │ REST                              │ MCP (streamable HTTP)
                 ▼                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                    @kioku/api (Express)                           │
│                                                                   │
│  routes/        meta · facts · recall · query · sessions          │
│      │                                                            │
│      ▼                                                            │
│  ingest/        consolidate · append · sessions · summary         │
│      │              ▲                                             │
│      ▼              │ uses                                        │
│  retrieval/     embeddings (hybrid) · scoring · text              │
│      │              ▲                                             │
│      ▼              │                                             │
│  query/         answer (single-shot LLM) · recall (ranked, no LLM)│
│      │                                                            │
│      ▼                                                            │
│  storage/       mongo · indexes · facts · entities · transcripts  │
│                 · history · session_summaries                     │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│             MongoDB (atlas-local on 127.0.0.1:27017)              │
│  facts (vec + bm25 indexes) · entities (vec) · transcripts        │
│  · session_summaries · history                                    │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                LLM + embedding providers (HTTP)                   │
│  LM Studio (default, http://localhost:1234) · OpenAI · any        │
│  OpenAI-compatible endpoint (vLLM, Ollama). Chat + embeddings     │
│  configured independently via LLM_* / EMBEDDING_* env vars.       │
└──────────────────────────────────────────────────────────────────┘
```

## Request Flow

### Ingest (`POST /sessions`)

```
1. Express parses body via SessionBody (zod)
       │
2. parseTranscript(raw) → { frontmatter, turns }
       │   gray-matter front-matter + `## t-N <role>` heading parser.
       │
3. upsertTranscript(parsed)
       │   Persisted in `transcripts` keyed by sessionId.
       │
4. consolidate(parsed, scope)
       │   ├─ getOrComputeSessionSummary  (cached narrative summary)
       │   ├─ for each 2-message batch:
       │   │     - embed batch text
       │   │     - top-10 cosine candidates from existing facts (in-scope) → fed into prompt
       │   │     - generateObject(extraction prompt, schema={memory:[{id,text,category}]})
       │   │     - embedMany(extracted texts)
       │   │     - cosine dedup vs (existing in-scope + prior-batches' extractions + this-batch accepted) at NEAR_DUPE_COSINE = 0.97
       │   │     - appendFacts (insertMany, ordered:false)
       │   │     - upsertEntitiesFromFacts (per-entity $setOnInsert + $addToSet)
       │   └─ returns { added, batches, failed }
       │   (if every batch failed: sessions.ts throws IngestExtractionError → 500)
       │
5. Response: { sessionId, added, batches, failed }
```

### Recall (`POST /recall` and the MCP `recall` tool)

```
1. Express parses body via RecallBody (zod)
       │
2. recall(query, { k, since, until, filters })
       │   When date filters present, over-fetches by 3× to absorb post-filter loss.
       │
3. defaultFactRanker(query, fetchK, { filters })
       │   ├─ lemmatizeForBm25(question)  →  "alex meet san francisco"
       │   ├─ embedQuestion(question)      →  qEmb
       │   ├─ $vectorSearch on facts_vec   →  top max(k*4, 60) by cosine
       │   ├─ $search on facts_text        →  top max(k*4, 60) by BM25 (whole corpus)
       │   ├─ union ids → fetch full docs (with metadata $match for dynamic filters)
       │   ├─ recompute cosine in app over the union (matches SEMANTIC_THRESHOLD=0.1 contract)
       │   ├─ normalizeBm25 with query-length-adaptive sigmoid params
       │   ├─ computeEntityBoosts(question)
       │   │     - extractEntities(question)
       │   │     - embedTexts(deduped, max 8)
       │   │     - $vectorSearch on entities_vec; sim ≥ 0.5 boosts linked fact ids
       │   └─ scoreAndRank(semantic, bm25, entity, threshold=0.1, k)
       │             additive fusion / max_possible (adapts to which signals fired) → [0, 1]
       │
4. Optional date post-filter on event_date → slice to k → response.
```

### Query (`POST /query` and the MCP `query` tool)

```
1. recall pipeline as above (default K from KIOKU_TOP_K, default 50)
       │
2. formatFactsGroupedByDateNewestFirst(facts)
       │   "--- 2025-08-12 ---" headers + "- <fact>" lines
       │
3. deriveQuestionDate(facts) — anchor for the answerer's relative-date arithmetic
       │
4. Read prompts/answer.md, substitute {question_date}, {memories}, {question}
       │
5. generateText({ model, prompt, temperature: 0, timeout: 120s })
       │
6. stripMemThinking(result.text) → answer
       │
7. extractCitations(facts) → deduped source sessions, raw/ prefix stripped
       │
8. Response: { answer, citations }   // citations = retrieved sessions, not answerer-grounded
```

## Boot Sequence

`apps/api/src/server.ts`:

1. Load `dotenv/config`
2. Build the Express app — `traceMiddleware`, `pinoHttp` (configured: see Logging below), `express.json({ limit: "10mb" })` (transcripts are big), route mounting, error handler
3. `await ensureIndexes()` — idempotent btree + Atlas Search + vector index setup, polled until READY (180 s ceiling, calibrated against atlas-local's mongot build times). Probes the embedding provider at startup so an `EMBEDDING_MODEL` change is detected here, not at the next write.
4. `app.listen(PORT, HOST)` — `PORT` from Portless, `7777` fallback; `HOST` defaults to `127.0.0.1`.
5. SIGINT / SIGTERM → close server → close Mongo client → exit.

If `ensureIndexes()` throws, the process exits and logs `kioku startup failed` with a stage-specific cause: a Mongo connect failure names `MONGODB_URI` and asks whether atlas-local is running, while an embedding probe failure names the resolved `EMBEDDING_BASE_URL`/`EMBEDDING_MODEL` and asks whether the embedding endpoint is up.

## Key Design Decisions

- **One Mongo, all collections.** `facts`, `entities`, `transcripts`, `session_summaries`, `history` — a single `mongodb-atlas-local` container handles dense vector search, BM25, the audit log, and the source-of-truth for ingest. Replaces what mem0 OSS splits across Qdrant + SQLite.
- **State lives entirely in Mongo — no filesystem-backed vault.** Transcripts are persisted in the `transcripts` collection on first ingest; re-ingest of the same `sessionId` does not duplicate facts because cosine dedup against existing in-scope facts catches re-extracted material (threshold 0.97 in consolidate).
- **Embeddings persisted at write time.** Query is one embed call. The dense pre-pass uses `$vectorSearch` (HNSW); cosine is recomputed in app over the candidate union to preserve the existing `SEMANTIC_THRESHOLD = 0.1` contract (Atlas's `vectorSearchScore` uses `(1 + cos) / 2` which would shift the threshold meaning).
- **Whole-corpus BM25.** `$search` runs against the whole corpus, not a cosine-prefiltered window. A fact strong on keywords but weak on cosine can still enter the top-K. The sigmoid that normalizes raw BM25 into the additive fusion is calibrated against Lucene's score range; refit via `scripts/probe-bm25-scores.ts`.
- **Atomic facts are write-once.** No UPDATE / DELETE / soft-archival on `facts`. Corrections happen by appending newer facts with later `event_date`; the answerer prompt resolves contradictions newest-wins (`prompts/answer.md`). Every mutation leaves a row in `history` for postmortem.
- **Race-safe writes by Mongo primitives where it matters.** `entities_text_lower_unique` plus `$setOnInsert` / `$addToSet` upserts on the entity store. Fact dedup is cosine-based at the ingest layer (`append.ts` and `consolidate.ts`); the single-fact append path serializes on a process-wide async lock because cosine is a read-then-act sequence.
- **mem0-OSS-shaped multi-tenancy.** Facts are scoped by `(user_id, run_id, agent_id)`. `user_id` defaults to `'default'`. Cosine dedup reads only in-scope facts, so identical text under different scopes does not collide. There is no auth layer; multi-tenancy is filter-based.
- **Provider-agnostic LLM + embeddings.** Access goes through the shared `@kagami/llm` gateway (`createInference`, openai-compatible) against any OpenAI-shaped endpoint (LM Studio, OpenAI, vLLM, Ollama). Chat and embedding providers are independent — typical setup is one line per role.
- **Reasoning-content middleware.** Thinking-mode models (GLM-4.7-flash, Qwen3.6) sometimes emit their final structured output into `reasoning_content` while leaving the assistant `content` empty. `@kagami/llm` applies a middleware (default-on for openai-compatible) that promotes the reasoning text to a text part when no real content is present. Without this, `generateObject` raises `AI_NoObjectGeneratedError`.
- **Stateless MCP.** A fresh transport + server connection per `/mcp` POST. The MCP-over-HTTP semantics don't need session state for our tool set — every call is a one-shot tool invocation.
- **Pull-only by design (system level).** Kioku exposes an API; it never initiates outbound calls to sibling services in the Kagami workspace. Its only outbound network calls are to the configured LLM and embedding endpoints.

## Module Map

| Directory                     | Purpose                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/ingest/`        | Transcript parsing + the atomic-fact extraction pipeline. `consolidate.ts` is the core; `append.ts` is the single-fact path; `sessions.ts` is the HTTP entry that glues them.                                                    |
| `apps/api/src/query/`         | Read paths above the ranker. `recall.ts` returns ranked facts; `answer.ts` runs the answerer prompt over them.                                                                                                                   |
| `apps/api/src/retrieval/`     | Hybrid ranker. `embeddings.ts` orchestrates the three signals; `scoring.ts` does the additive fusion + BM25 sigmoid; `text.ts` is the lemmatizer + entity extractor.                                                             |
| `apps/api/src/routes/`        | Express routers, one per resource. `filters.ts` is the shared zod schema for the mem0-shaped filter payload.                                                                                                                     |
| `apps/api/src/storage/`       | Mongo. `mongo.ts` is the lazy client singleton; `indexes.ts` is the idempotent index setup with READY-polling; the rest are per-collection accessors.                                                                            |
| `apps/api/src/mcp.ts`         | Streamable-HTTP MCP transport. Seven tools (`recall`, `query`, `append_fact`, `append_facts`, `ingest_session`, `fact_count`, `fact_history`).                                                                                   |
| `apps/api/src/llm.ts`         | Env resolution (canonical keys + legacy profile shim) and `@kagami/llm` `createInference` wiring; exports `model`, `getEmbeddingModel`, `embedQuestion`, `embedTexts`, `llmEndpoint`, `embeddingEndpoint`, `embeddingModelName`. |
| `apps/api/prompts/`           | `extraction.md` (ingest), `answer.md` (answerer). Read at runtime by ingest/consolidate and query/answer respectively. Cached after first read.                                                                                  |
| `apps/api/scripts/`           | One-off tools: `longmemeval.ts` + worker (bench); `probe-bm25-scores.ts` (BM25 sigmoid calibration); `citation-recall.ts` + `variance-probe.ts` (recall probes).                                                                 |
| `apps/api/bench/longmemeval/` | LongMemEval runner + datasets + results. See [bench.md](bench.md).                                                                                                                                                               |
| `apps/dashboard/src/`         | Next.js 15 App Router inspector. See [dashboard.md](dashboard.md).                                                                                                                                                               |

## Cross-cutting Concerns

- **Logging.** `apps/api/src/logger.ts` is a thin wrapper around `@kagami/logger`'s `createLogger`, which provides the stable `service`/`component`/`env` bindings and the common secret-redaction list. `pino-http` is mounted as middleware so every request gets a `req.log`. Pretty transport whenever `NODE_ENV !== "production"`. The `pino-http` instance is configured (not default): `/health` probes are not logged at all (`autoLogging.ignore`); the completion line's level is by outcome — `info` for <400, `warn` for 4xx, `silent` for ≥500 (the error handler and `mcp.ts` already log every 5xx with the full stack + context, so the completion line would be a duplicate), and `error` only for pino-http's own transport-level errors; and the `req`/`res` serializers are trimmed to `{ method, url, id }` / `{ statusCode }` instead of dumping every header.
- **Error handling.** A single Express error handler maps `ZodError` → `400 { error: "validation_error", issues }` and everything else → `500 { error: "internal_error" }` with a logged `req.log.error`.
- **Timeouts.** Embed calls use `AbortSignal.timeout(5_000)` (single) / `15_000` / `30_000` (batched). Extraction `generateObject` is `120_000`. Summary `generateObject` is `60_000`. Answerer `generateText` is `120_000`.
- **Caching.** The two prompts (`extraction.md`, `answer.md`) are read once and cached in module scope. The narrative session summary is persisted in the `session_summaries` collection so re-ingest is free.
