# CLAUDE.md

## Project

Kioku — a personal long-term memory subsystem. Atomic facts in MongoDB + hybrid retrieval (`$vectorSearch` + `$search` + entity boost) + a single MCP server interface. Designed to be consumed over HTTP by external agents (Kokoro is the primary client). Built as a monorepo with TypeScript, Express, the Vercel AI SDK (`@ai-sdk/openai-compatible`), and a Next.js dashboard for inspection.

## Monorepo Structure

```
kioku/
├── apps/
│   ├── api/          # Express HTTP server + MCP transport (entry: src/server.ts)
│   │   ├── src/
│   │   │   ├── ingest/      # consolidate, append, sessions, session-summary, transcript parser
│   │   │   ├── query/       # answer.ts (single-shot LLM answerer) + recall.ts (no-LLM ranked retrieval)
│   │   │   ├── retrieval/   # hybrid ranker (cosine + BM25 + entity boost), scoring, lemmatizer + entity extractor
│   │   │   ├── routes/      # per-resource Express routers (facts, recall, query, sessions, meta, filters)
│   │   │   ├── storage/     # mongo singleton, idempotent indexes, facts, entities, transcripts, history
│   │   │   ├── server.ts    # express bootstrap + ensureIndexes + graceful shutdown
│   │   │   ├── mcp.ts       # streamable-HTTP MCP transport mounted at /mcp
│   │   │   ├── llm.ts       # provider profiles, model factory, embed helpers
│   │   │   ├── paths.ts     # prompts directory pointer
│   │   │   ├── types.ts     # Transcript / Turn / frontmatter zod schemas
│   │   │   └── logger.ts    # pino logger
│   │   ├── prompts/
│   │   │   ├── extraction.md   # ingest prompt (8K-token rulebook)
│   │   │   └── answer.md       # answerer prompt (3K-token rulebook)
│   │   ├── tests/           # node:test suite + mongodb-memory-server harness
│   │   ├── scripts/         # cc-to-transcript, cc-ingest-chunked, longmemeval, probe-bm25-scores
│   │   └── bench/longmemeval/  # benchmark runner + datasets + results
│   └── dashboard/    # Next.js 15 inspector at https://kioku.localhost
├── packages/
│   ├── typescript-config/  # shared tsconfig bases (base/server/library/nextjs JSON)
│   └── eslint-config/      # shared flat config
├── portless.json     # api.kioku + kioku Portless registrations
└── docs/
```

**Stack**: npm workspaces + Turborepo. The two `packages/*` are JSON/JS config — there are no shared TypeScript libraries. Apps depend on each other only via HTTP (the dashboard calls the API at `KIOKU_API_URL`).

## Commands

```bash
npm run build           # turbo run build (dashboard only — api has no build step)
npm run dev             # both apps under Portless (https://kioku.localhost + https://api.kioku.localhost)
npm run dev:api         # API only
npm run dev:dashboard   # Dashboard only
npm run typecheck       # turbo run typecheck (all packages)
npm run test            # turbo run test (node:test + mongodb-memory-server, ~per-test ~3s)
npm run lint            # turbo run lint
npm run lint:fix        # turbo run lint:fix
npm run format          # prettier --write all files
npm run format:check    # prettier --check
```

Apps run under [Portless](https://github.com/vercel-labs/portless) at `https://kioku.localhost` (dashboard) and `https://api.kioku.localhost` (API). HTTPS is auto-trusted; first run prompts once for sudo to install the local CA. Portless injects `PORT`; `7777` is the standalone fallback for the API.

The benchmark runner lives at `apps/api/bench/longmemeval/README.md` — see [bench.md](docs/bench.md).

## Dependency Graph

```
@kioku/typescript-config  ← leaf
@kioku/eslint-config      ← leaf
       ↑
@kioku/api          ← Express server, MCP, ingest + retrieval pipelines
@kioku/dashboard    ← Next.js inspector (talks to API over HTTP via KIOKU_API_URL)
```

Apps share no in-process code. The dashboard reaches the API only through `fetch` to `https://api.kioku.localhost`; the runtime contract is the REST surface in `apps/api/src/routes/*`.

## Conventions

- **TypeScript + ESM** — strict mode, ES2022 target, `NodeNext` module resolution for the API; bundler resolution for the dashboard. Server config sets `noUncheckedIndexedAccess`.
- **Async everywhere** — all I/O is async/await, no callbacks
- **Zod at boundaries** — request bodies validated in `apps/api/src/routes/*` and `mcp.ts`; transcript frontmatter validated in `types.ts`. Internal modules trust their inputs.
- **Pino logging** — structured logs via `logger.info({ context }, "message")`. `pino-http` is mounted on the API. Pretty transport in non-production.
- **Vercel AI SDK + OpenAI-compatible provider** — `generateObject()` for extraction/summary, `generateText()` for the answerer, `embed()` / `embedMany()` for vectors. Any OpenAI-compatible endpoint works (LM Studio, OpenAI, vLLM, Ollama).
- **No classes for services** — prefer standalone exported functions. Routers, ranker, ingest paths, and MCP tools are all plain functions.
- **Atomic facts are write-once** — no UPDATE/DELETE on the `facts` collection. Corrections happen by appending newer facts with later `event_date`; the answerer prompt resolves contradictions newest-wins. Every mutation leaves a row in `history`.
- **Race-safe by Mongo primitives** — unique indexes (`facts_hash_unique`, `entities_text_lower_unique`) plus `$setOnInsert` / `$addToSet` upserts. Append paths additionally serialize on a process-wide async lock so the cosine near-dupe check can't race with itself.
- **Embeddings persisted at write time** — query is one embed call; the dense pre-pass uses `$vectorSearch` (HNSW), with cosine recomputed in app over the candidate union to preserve the `SEMANTIC_THRESHOLD = 0.1` contract (Atlas's `(1 + cos) / 2` transform doesn't line up).
- **Whole-corpus BM25** — `$search` runs against the whole `facts_text` corpus, not a cosine-prefiltered window, so a fact strong on keywords but weak on cosine can still surface. The sigmoid that normalizes raw BM25 into the additive fusion is calibrated against Lucene/Atlas's score range — re-tune via `scripts/probe-bm25-scores.ts`.
- **mem0-OSS-shaped multi-tenancy** — facts are scoped by `(user_id, run_id, agent_id)`. `user_id` defaults to `'default'`. The hash unique index is scoped by the full tuple so identical text under different scopes does not collide. There is no auth layer; multi-tenancy is filter-based.
- **`.env` location** — `apps/api/.env` (not root). `apps/api/.env.example` is the template.
- **Tests as source of truth** — when a test fails because production behaves differently than the test expects, fix the API, not the test. See [docs/testing.md](docs/testing.md).
- **Cross-package imports** — `@kioku/typescript-config`, `@kioku/eslint-config` only; no cross-app TS imports.
- **Within-package imports** — relative paths with explicit `.js` extensions (NodeNext requirement on the API).
- **Internal packages pattern** — both `packages/*` are config-only (JSON exports / a single `base.js`). No build step.

## Doc Maintenance

After any code change, update the relevant doc in `/docs` to reflect the change. If a new module or major feature is added, create a new doc file. Keep docs accurate — they are the primary architecture reference.

See `/docs` for:

- [architecture.md](docs/architecture.md) — system overview, request flow, module map, boot sequence, design decisions
- [ingest.md](docs/ingest.md) — transcript → atomic facts pipeline (consolidate, append, sessions, session-summary)
- [retrieval.md](docs/retrieval.md) — hybrid ranker (cosine + BM25 + entity boost), scoring, lemmatizer, entity extractor
- [storage.md](docs/storage.md) — Mongo collections, idempotent indexes, scope-aware reads, audit log
- [api.md](docs/api.md) — REST surface (`/facts`, `/recall`, `/query`, `/sessions`, `/health`, `/version`) and MCP tools at `/mcp`
- [dashboard.md](docs/dashboard.md) — Next.js inspector, design system, page map
- [configuration.md](docs/configuration.md) — env vars, provider profiles, common LLM/embedding combos, MongoDB setup
- [testing.md](docs/testing.md) — node:test + mongodb-memory-server harness, what's covered, how to add tests
- [bench.md](docs/bench.md) — LongMemEval runner, headline numbers, BM25 calibration tool
