# Configuration

API config lives at `apps/api/.env`. Copy `apps/api/.env.example` to start. The dashboard reads only `KIOKU_API_URL` and inherits `PORT` from Portless.

## Provider profiles

Kioku uses `@ai-sdk/openai-compatible`, so any OpenAI-shaped endpoint works (LM Studio, OpenAI, vLLM, Ollama, …). Two profiles in `apps/api/src/llm.ts` fill in URL + key defaults so a typical setup is one line per role:

```ts
PROFILES = {
  lmstudio: { baseURL: "http://localhost:1234/v1", apiKey: "lm-studio" },
  openai: { baseURL: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY ?? "" },
};
```

Explicit `LLM_URL` / `LLM_API_KEY` (and `EMBEDDING_*` counterparts) always win as overrides. Chat and embedding providers are independent — pick separately.

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

# ── Chat / answerer ─────────────────────────────────────
LLM_PROVIDER=lmstudio                            # 'lmstudio' or 'openai'
MODEL=zai-org/glm-4.7-flash                      # provider-native model id
# LLM_URL=http://localhost:1234/v1               # override
# LLM_API_KEY=lm-studio                          # override

# ── Embeddings (independent provider) ───────────────────
EMBEDDING_PROVIDER=lmstudio                      # 'lmstudio' or 'openai'
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
# EMBEDDING_URL=...                              # override
# EMBEDDING_API_KEY=...                          # override

# ── Used as the *_API_KEY default when *_PROVIDER=openai
OPENAI_API_KEY=sk-...

# ── Logging ─────────────────────────────────────────────
# LOG_LEVEL=info                                 # pino level
# NODE_ENV=development                           # pretty transport unless 'production'
```

## Common combinations

- **All-local** — LM Studio on `localhost:1234` for both chat and embeddings:

  ```sh
  LLM_PROVIDER=lmstudio
  EMBEDDING_PROVIDER=lmstudio
  MODEL=zai-org/glm-4.7-flash
  EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
  ```

- **All-OpenAI** — paid chat + paid embeddings:

  ```sh
  LLM_PROVIDER=openai
  EMBEDDING_PROVIDER=openai
  MODEL=gpt-4o-mini
  EMBEDDING_MODEL=text-embedding-3-small
  OPENAI_API_KEY=sk-...
  ```

- **Hybrid (cheap chat, free embed)** — OpenAI answerer, local LM Studio embeddings:
  ```sh
  LLM_PROVIDER=openai
  MODEL=gpt-4o-mini
  OPENAI_API_KEY=sk-...
  EMBEDDING_PROVIDER=lmstudio
  EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
  ```

The provider abstraction collapses to a single OpenAI-compatible client when chat and embedding URLs/keys match (no duplicate provider instance).

## Write rate limits

`POST /facts/bulk` and `POST /sessions` run embedding-heavy ingest work. Kioku applies per-IP rate limits over a 60-second window before either handler starts provider calls:

| Env var                            | Default | Endpoint           |
| ---------------------------------- | ------- | ------------------ |
| `KIOKU_BULK_RATE_LIMIT_PER_MIN`    | `10`    | `POST /facts/bulk` |
| `KIOKU_SESSION_RATE_LIMIT_PER_MIN` | `5`     | `POST /sessions`   |

Rate-limited requests return `429 { error: "rate_limited", limit, window_seconds: 60 }` with standard `RateLimit` headers.

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

See `Kagami/ARCHITECTURE.md` for the full cross-service map.
