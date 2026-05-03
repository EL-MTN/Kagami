# Brainiac

A personal long-term memory system. Atomic facts on disk + hybrid retrieval + a single MCP server interface.

Benchmarked at **76%** on a 100-item LongMemEval-Oracle subset with the full hybrid (cosine + BM25 + entity boost), on GPT-4o-mini answerer + judge. An earlier cosine + BM25-only configuration scored **78%** on the same subset.

**Head-to-head vs. mem0 OSS**: 76% / 76% on the same 100 question_ids, same models, mem0's v3 pipeline running its native top_k=200 vs. Brainiac's top_k=50. Per-type the systems make different mistakes — mem0 is stronger on temporal-reasoning (88.3% vs. 81.7%), Brainiac is stronger on multi-session (67.5% vs. 57.5%) — but the headline is a wash, suggesting the port is faithful. mem0's widely-cited "91% OSS" headline uses gpt-5 + full 500 questions; that operating point was not run here.

## Architecture

```
src/
  mcp_server.ts          MCP server — view/create/str_replace/consolidate/query/fact_count
  query.ts               public query API — hybrid retrieval → single-shot answerer
  ingest.ts              public ingest API — transcript → atomic facts + entities
  llm.ts                 LLM provider (OpenAI-compatible) + embed helpers
  paths.ts               vault paths
  transcript.ts          transcript parsing (raw/<session>.md)
  types.ts               shared schemas
  storage/
    facts.ts             .memory/facts.jsonl — atomic facts with embeddings
    entities.ts          .memory/entities.jsonl — entities with linked fact ids
  retrieval/
    embeddings.ts        hybrid ranker (cosine + BM25 + entity boost)
    bm25.ts              in-memory Okapi BM25
    scoring.ts           additive scoring fusion
    text.ts              lemmatization + entity extraction
prompts/
  extraction.md          ingest prompt (8K-token rulebook)
  answer.md              answerer prompt (3K-token rulebook)
```

### Vault layout

```
$BRAINIAC_VAULT/
  _core.md                always-loaded canonical user state, hand-edited
  raw/<session>.md        immutable transcripts (input to ingest)
  .memory/
    facts.jsonl           one atomic fact per line: text + md5 hash + embedding + dates
    entities.jsonl        one entity per line: text + embedding + linked_memory_ids
    llm-failures/         dropped LLM responses, for debugging
```

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
5. Fuse the three signals via additive scoring (`semantic + bm25 + entity_boost / max_possible`), take top-K = 50.
6. Group surviving facts by date (newest-first), feed to the answerer prompt, strip `<mem_thinking>` block from output.

## Configuration

```sh
# .env
BRAINIAC_VAULT=/path/to/your/vault                # required
BRAINIAC_TOP_K=50                                 # optional, default 50

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
- **`_core.md` is the only hand-editable artifact.** Atomic facts are write-once; edit by re-ingesting a corrected transcript.

The architecture is closely modeled on the open-source memory benchmarks at [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks). Implementation is independent (pure TypeScript, no spaCy / qdrant / Docker) but the prompts, scoring formulas, and pipeline shape come from there.
