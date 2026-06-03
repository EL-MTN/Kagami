# Configuration

API config lives at `apps/api/.env`. Copy `apps/api/.env.example` to start. The dashboard reads only `KIOKU_API_URL` and inherits `PORT` from Portless.

## Provider config

Kioku reaches all models through the shared `@kagami/llm` gateway
(`createInference`, `kind: "openai-compatible"`), so any OpenAI-shaped endpoint
works (LM Studio, OpenAI, vLLM, Ollama, …). The gateway owns provider
construction, structured-output mode, the LM-Studio `reasoning_content` repair
(default-on), retry, and span/usage emission.

Canonical keys are `LLM_KIND` / `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` /
`LLM_TIMEOUT_MS` and the `EMBEDDING_*` counterparts. Chat and embedding
endpoints are independent — set each separately.

## Reference

```sh
# apps/api/.env

# ── Retrieval ───────────────────────────────────────────
KIOKU_TOP_K=50                                   # answerer top-K (default 50)

# ── MongoDB (defaults to local atlas-local on 27017) ────
# Include the DB name in the path; mongo.ts reads it from the URI.
# MONGODB_URI=mongodb://127.0.0.1:27017/kioku?directConnection=true

# ── Ingest rate limits (per IP, one-minute window) ──────
# KIOKU_BULK_RATE_LIMIT_PER_MIN=10             # POST /facts/bulk
# KIOKU_SESSION_RATE_LIMIT_PER_MIN=5           # POST /sessions

# ── Standalone bind (only used outside Portless) ────────
# PORT=7777                                      # Portless injects this; 7777 is the fallback
# KIOKU_HOST=127.0.0.1

# ── Chat / answerer (via @kagami/llm, openai-compatible) ─
LLM_KIND=openai-compatible
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=zai-org/glm-4.7-flash                  # provider-native model id
# LLM_TIMEOUT_MS=180000                          # optional per-attempt deadline

# ── Embeddings (independent endpoint) ───────────────────
EMBEDDING_KIND=openai-compatible
EMBEDDING_BASE_URL=http://localhost:1234/v1
EMBEDDING_API_KEY=lm-studio
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5

# ── Logging ─────────────────────────────────────────────
# LOG_LEVEL=info                                 # pino level
# NODE_ENV=development                           # pretty transport unless 'production'
```

## Common combinations

- **All-local** — LM Studio on `localhost:1234` for both chat and embeddings:

  ```sh
  LLM_KIND=openai-compatible
  LLM_BASE_URL=http://localhost:1234/v1
  LLM_API_KEY=lm-studio
  LLM_MODEL=zai-org/glm-4.7-flash
  EMBEDDING_KIND=openai-compatible
  EMBEDDING_BASE_URL=http://localhost:1234/v1
  EMBEDDING_API_KEY=lm-studio
  EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
  ```

- **All-OpenAI** — paid chat + paid embeddings:

  ```sh
  LLM_KIND=openai-compatible
  LLM_BASE_URL=https://api.openai.com/v1
  LLM_API_KEY=sk-...
  LLM_MODEL=gpt-4o-mini
  EMBEDDING_KIND=openai-compatible
  EMBEDDING_BASE_URL=https://api.openai.com/v1
  EMBEDDING_API_KEY=sk-...
  EMBEDDING_MODEL=text-embedding-3-small
  ```

- **Hybrid (cheap chat, free embed)** — OpenAI answerer, local LM Studio embeddings:
  ```sh
  LLM_KIND=openai-compatible
  LLM_BASE_URL=https://api.openai.com/v1
  LLM_API_KEY=sk-...
  LLM_MODEL=gpt-4o-mini
  EMBEDDING_KIND=openai-compatible
  EMBEDDING_BASE_URL=http://localhost:1234/v1
  EMBEDDING_API_KEY=lm-studio
  EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
  ```

`@kagami/llm` builds the chat and embedding providers independently; the
gateway owns the OpenAI-compatible client construction.

## Write rate limits

`POST /facts/bulk` and `POST /sessions` run embedding-heavy ingest work. Kioku applies per-IP rate limits over a 60-second window before either handler starts provider calls:

| Env var                            | Default | Endpoint           |
| ---------------------------------- | ------- | ------------------ |
| `KIOKU_BULK_RATE_LIMIT_PER_MIN`    | `10`    | `POST /facts/bulk` |
| `KIOKU_SESSION_RATE_LIMIT_PER_MIN` | `5`     | `POST /sessions`   |

Rate-limited requests return `429 { error: "rate_limited", limit, window_seconds: 60 }` with the IETF draft-8 `RateLimit-*` headers (via `express-rate-limit`). The env vars above are parsed once at boot by `parseRateLimitPerMinute` and surfaced through the `kiokuRateLimits` constant in `apps/api/src/routes/rate-limit.ts`.

## Embedding-model swaps

Kioku probes the embedding provider's output dimension at startup (`embedQuestion("probe")` in `apps/api/src/storage/indexes.ts`). If the existing `facts_vec` / `entities_vec` index dimension differs from the probed dimension, `ensureIndexes` raises:

```
vector index facts_vec on facts was built for numDimensions=1536 but the embedding
provider now returns 768. Did EMBEDDING_MODEL change? Drop the index
(db.facts.dropSearchIndex("facts_vec")) and restart.
```

Drop both `facts_vec` and `entities_vec`, then restart — `ensureIndexes()` rebuilds against the new dimension. Existing facts keep their old embeddings on disk; until they're re-ingested, ranking against new query embeddings will be meaningless. Plan a re-ingest after a dimension change.

## MongoDB setup

The default URI targets a local Atlas Search instance. Vanilla MongoDB doesn't support `$vectorSearch` or `$search`, so production needs atlas-local (or full Atlas).

```sh
# easiest: the official atlas-local image
atlas local start mongodb
# or:
docker run -d -p 27017:27017 mongodb/mongodb-atlas-local
```

The test harness uses `mongodb-memory-server` (vanilla mongo) — `ensureIndexes({ allowMissingSearch: true })` skips the search/vector indexes when the server doesn't support them. See [testing.md](testing.md).

## Portless

Both apps register through `portless.json` at the repo root:

```json
{
  "apps": {
    "apps/dashboard": { "name": "kioku" },
    "apps/api": { "name": "api.kioku" }
  }
}
```

Portless picks an ephemeral port per app and routes:

- `https://kioku.localhost` → dashboard
- `https://api.kioku.localhost` → API

First run prompts once for sudo to install a local CA (HTTPS auto-trusted thereafter). The numeric ports in `apps/api/src/server.ts` (`7777` fallback) only matter when running standalone.

## Inter-service config

Default Kioku URLs across the Kagami workspace:

| Caller          | Env var         | Default                       |
| --------------- | --------------- | ----------------------------- |
| Kokoro bot      | `KIOKU_URL`     | `https://api.kioku.localhost` |
| Kioku dashboard | `KIOKU_API_URL` | `https://api.kioku.localhost` |

See [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the full cross-service map.
