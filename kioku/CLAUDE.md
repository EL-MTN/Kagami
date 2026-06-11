# CLAUDE.md

## Project

Kioku — a personal long-term memory subsystem. Atomic facts in MongoDB + hybrid retrieval (`$vectorSearch` + `$search` + entity boost) + a single MCP server interface. Designed to be consumed over HTTP by external agents (Kokoro is the primary client). Built with TypeScript, Express, the `@kagami/llm` inference gateway (OpenAI-compatible), and a Next.js dashboard for inspection. Lives as a subtree inside the Kagami nested monorepo.

This file is the project guide. Cross-service facts live in the workspace root: see [`../CLAUDE.md`](../CLAUDE.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Monorepo Structure

```
kioku/                # subtree of the Kagami workspace; no project-local package.json / turbo.json
├── apps/
│   ├── api/          # Express HTTP server + MCP transport (entry: src/server.ts)
│   │   ├── src/
│   │   │   ├── ingest/      # consolidate, append, curate, sessions, session-summary, transcript parser
│   │   │   ├── query/       # answer.ts (single-shot LLM answerer) + recall.ts (no-LLM ranked retrieval)
│   │   │   ├── retrieval/   # hybrid ranker (cosine + BM25 + entity boost), scoring, lemmatizer + entity extractor
│   │   │   ├── routes/      # per-resource Express routers (facts, recall, query, sessions, meta, filters)
│   │   │   ├── storage/     # mongo singleton, idempotent indexes, facts, entities, transcripts, history
│   │   │   ├── server.ts    # express bootstrap + ensureIndexes + graceful shutdown
│   │   │   ├── mcp.ts       # streamable-HTTP MCP transport mounted at /mcp
│   │   │   ├── llm.ts       # env resolution (canonical keys) + @kagami/llm createInference wiring + embed helpers
│   │   │   ├── paths.ts     # prompts directory pointer
│   │   │   ├── types.ts     # Transcript / Turn / frontmatter zod schemas
│   │   │   └── logger.ts    # pino logger
│   │   ├── prompts/
│   │   │   ├── extraction.md   # ingest prompt (8K-token rulebook)
│   │   │   ├── answer.md       # answerer prompt (3K-token rulebook)
│   │   │   └── curate.md       # curation prompt (operator-run drop/merge/rewrite pass)
│   │   ├── tests/           # vitest suite + mongodb-memory-server harness
│   │   ├── scripts/         # longmemeval, longmemeval-worker, citation-recall, probe-bm25-scores, variance-probe, curate
│   │   ├── tsconfig.json    # extends @kagami/tsconfig/server.json (+ esModuleInterop, allowImportingTsExtensions)
│   │   ├── tsconfig.build.json # prod build: tsc -p this → dist/ (extends @kagami/tsconfig/server.build.json)
│   │   ├── eslint.config.js # imports from @kagami/eslint-config/base
│   │   └── bench/longmemeval/  # benchmark runner + datasets + results
│   └── dashboard/    # Next.js 16 inspector at https://kioku.localhost
│       ├── tsconfig.json    # extends @kagami/tsconfig/nextjs.json (+ esModuleInterop)
│       └── eslint.config.js # imports from @kagami/eslint-config/base
├── portless.json     # api.kioku + kioku Portless registrations
└── docs/
```

**Stack**: Kioku is a _subtree_ inside the Kagami nested monorepo. The Kagami workspace root owns `package.json`, `turbo.json`, and `package-lock.json`; npm workspaces and Turborepo span the domain projects plus Cockpit. Tooling and runtime helpers are shared via the workspace-level `@kagami/eslint-config`, `@kagami/tsconfig`, `@kagami/logger`, and `@kagami/llm` packages (which live in `shared/packages/` at the Kagami root). Kioku has no project-internal TypeScript packages today — `kioku/packages/` is empty (or absent). Apps depend on each other only via HTTP (the dashboard calls the API at `KIOKU_API_URL`).

## Commands

All commands run from the **Kagami workspace root** (`/Users/mastermind/Desktop/Programming/Kagami/`). To work on Kioku in isolation, use the `kioku:*` script aliases.

```bash
# From Kagami root:
./dev-all.sh                  # boot all domain services plus Cockpit with prefixed output
npm run kioku:dev             # both Kioku apps under Portless (https://kioku.localhost + https://api.kioku.localhost)
npm run kioku:dev:api         # API only
npm run kioku:dev:dashboard   # Dashboard only
npm run typecheck             # turbo run typecheck across the whole workspace
npm run test                  # turbo run test across the whole workspace
npm run lint                  # turbo run lint
npm run format                # prettier --write
# To filter to Kioku only:
npx turbo run typecheck --filter="@kioku/*"
npx turbo run test     --filter="@kioku/*"
npx turbo run lint     --filter="@kioku/*"
npx turbo run build    --filter="@kioku/*"   # api (tsc -p tsconfig.build.json → dist/) + dashboard
# Watch mode for the API tests (vitest auto-discovers kioku/vitest.config.ts):
cd kioku/apps/api && npm run test:watch
```

Apps run under [Portless](https://github.com/vercel-labs/portless) at `https://kioku.localhost` (dashboard) and `https://api.kioku.localhost` (API). HTTPS is auto-trusted; first run prompts once for sudo to install the local CA. Portless injects `PORT`; `7777` is the standalone fallback for the API.

The benchmark runner lives at `apps/api/bench/longmemeval/README.md` — see [bench.md](docs/bench.md).

## Dependency Graph

```
@kagami/eslint-config, @kagami/tsconfig, @kagami/llm (workspace-shared, live in shared/packages/)
       ↑
@kioku/api          ← Express server, MCP, ingest + retrieval pipelines
@kioku/dashboard    ← Next.js inspector (talks to API over HTTP via KIOKU_API_URL)
```

Apps share no in-process code. The dashboard reaches the API only through `fetch` to `https://api.kioku.localhost`; the runtime contract is the REST surface in `apps/api/src/routes/*`.

## Conventions

- **TypeScript + ESM** — strict mode, ES2022 target, `NodeNext` module resolution for the API; bundler resolution for the dashboard. Server config sets `noUncheckedIndexedAccess`.
- **Async everywhere** — all I/O is async/await, no callbacks
- **Zod at boundaries** — request bodies validated in `apps/api/src/routes/*` and `mcp.ts`; transcript frontmatter validated in `types.ts`. Internal modules trust their inputs.
- **Pino logging** — structured logs via `logger.info({ context }, "message")`. The logger is built from the workspace-shared `@kagami/logger` factory, which emits ECS / OTel field names (`log.level`, `@timestamp`, `service.*`, `trace.id`, `error.{type,message,stack_trace}`, …) and an `error`-key serializer (raw `Error`s keep their stack). There is no secret/PII redaction — it was removed (local-trust only; reintroduce before any non-localhost exposure). `pino-http` is mounted on the API. Console output is `pino-pretty` only on an interactive TTY or `LOG_PRETTY=1`, raw NDJSON otherwise. When `KANSOKU_URL` and `KANSOKU_INGEST_TOKEN` are set, logs also stream to the workspace's Kansoku service via a fail-open in-process shipper.
- **Trace context** — `traceMiddleware` from `@kagami/logger/express-trace` is mounted before `pinoHttp` so every log line inside a request — including body-parse errors (`PayloadTooLargeError`, malformed JSON) and pino-http's completion log — auto-carries `traceId`/`spanId` via the pino mixin. Incoming W3C `traceparent` headers (e.g. from Kokoro's `tracedFetch`) open a child span; absence mints a fresh trace.
- **Inference via `@kagami/llm`** — `generateObject()` (extraction/summary) and `generateText()` (answerer) run on models from the `@kagami/llm` gateway; `embed()` / `embedMany()` still call the `ai` SDK directly. Any OpenAI-compatible endpoint works (LM Studio, OpenAI, vLLM, Ollama).
- **No classes for services** — prefer standalone exported functions. Routers, ranker, ingest paths, and MCP tools are all plain functions.
- **Atomic facts are write-once on ingest** — the ingest path never UPDATEs/DELETEs the `facts` collection. Corrections happen by appending newer facts with later `event_date`; the answerer prompt resolves contradictions newest-wins. The one sanctioned mutation path is the operator-run curation pass (`ingest/curate.ts` via `scripts/curate.ts`): LLM-judged drop/merge/rewrite of accreted noise, every mutation journaled as an UPDATE/DELETE row in `history` (actor `curate`). Every mutation leaves a row in `history`.
- **Race-safe by Mongo primitives where it matters** — `entities_text_lower_unique` plus `$setOnInsert` / `$addToSet` upserts on the entity store. Fact dedup is cosine-based at the ingest layer (no storage-layer hash index); the single-fact append path serializes on a process-wide async lock so concurrent cosine read-then-act calls don't both insert.
- **Embeddings persisted at write time** — query is one embed call; the dense pre-pass uses `$vectorSearch` (HNSW), with cosine recomputed in app over the candidate union to preserve the `SEMANTIC_THRESHOLD = 0.1` contract (Atlas's `(1 + cos) / 2` transform doesn't line up).
- **Whole-corpus BM25** — `$search` runs against the whole `facts_text` corpus, not a cosine-prefiltered window, so a fact strong on keywords but weak on cosine can still surface. The sigmoid that normalizes raw BM25 into the additive fusion is calibrated against Lucene/Atlas's score range — re-tune via `scripts/probe-bm25-scores.ts`.
- **mem0-OSS-shaped multi-tenancy** — facts are scoped by `(user_id, run_id, agent_id)`. `user_id` defaults to `'default'`. Cosine dedup at append/consolidate is scope-bound by reading only in-scope facts, so identical text under different scopes does not collide. There is no auth layer; multi-tenancy is filter-based.
- **`.env` location** — `apps/api/.env` (not root). `apps/api/.env.example` is the template.
- **Tests as source of truth** — when a test fails because production behaves differently than the test expects, fix the API, not the test. See [docs/testing.md](docs/testing.md).
- **Cross-package imports** — `@kagami/eslint-config`, `@kagami/tsconfig`, and `@kagami/llm` (the runtime inference gateway, consumed by `apps/api/src/llm.ts`); no project-internal packages today; no cross-app TS imports.
- **Within-package imports** — relative paths with explicit `.js` extensions (NodeNext requirement on the API).
- **Internal packages pattern** — Kioku has no project-internal TS packages today. The apps consume only the shared `@kagami/*` config packages from the Kagami workspace root (`shared/packages/`); the former `kioku/packages/typescript-config` and `kioku/packages/eslint-config` were folded into those workspace-level packages during the Kagami migration.

## Where to find things

Common tasks → files. When a task touches multiple files, all are listed.

| Task                                                           | File(s)                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a REST endpoint                                            | New router in `apps/api/src/routes/<name>.ts` + mount in `apps/api/src/server.ts`                                                                                                                                                                                                        |
| Add an ingest pipeline step                                    | `apps/api/src/ingest/` (e.g. `consolidate.ts`, `append.ts`, `sessions.ts`); wire into `ingestSessionFromString()` in `sessions.ts`                                                                                                                                                       |
| Curate the live store (LLM drop/merge/rewrite of noisy facts)  | `apps/api/src/ingest/curate.ts` + `prompts/curate.md`; operator CLI `npx tsx apps/api/scripts/curate.ts` (dry run by default, `--apply` to execute)                                                                                                                                      |
| Add a retrieval scorer / re-ranker                             | `apps/api/src/retrieval/embeddings.ts` (`defaultFactRanker`) + `apps/api/src/retrieval/scoring.ts` (fusion)                                                                                                                                                                              |
| Hybrid retrieval glue ($vectorSearch + $search + entity boost) | `apps/api/src/retrieval/embeddings.ts` + `scoring.ts` + `text.ts` (lemmatizer + entity extractor)                                                                                                                                                                                        |
| Add a fact schema field                                        | `apps/api/src/storage/facts.ts` (extend `Fact` interface) + `apps/api/src/storage/indexes.ts` if filterable                                                                                                                                                                              |
| Add a Mongo index                                              | `apps/api/src/storage/indexes.ts` (idempotent `ensureIndexes()`)                                                                                                                                                                                                                         |
| Add an env var                                                 | `apps/api/src/env.ts` (`@kagami/env` spec: schema + doc metadata), then `npm run env:gen` — `.env.example`, the docs table, and `apps/api/turbo.json` are generated. Runtime reads via `loadEnv()` (`apps/api/src/config.ts`); BM25/rate-limit overrides keep their module-local parsers |
| Add a benchmark / LongMemEval probe                            | `apps/api/scripts/longmemeval.ts` (orchestrator) + `apps/api/scripts/longmemeval-worker.ts` + datasets under `apps/api/bench/longmemeval/`                                                                                                                                               |
| Add a dashboard page                                           | `apps/dashboard/src/app/<route>/page.tsx`; API proxy at `apps/dashboard/src/app/api/<route>/route.ts`; data fetcher at `apps/dashboard/src/lib/api.ts`                                                                                                                                   |
| Logger init                                                    | `apps/api/src/logger.ts`                                                                                                                                                                                                                                                                 |
| API server entrypoint                                          | `apps/api/src/server.ts` (Express bootstrap, router mounting, `ensureIndexes()`, graceful shutdown)                                                                                                                                                                                      |
| MCP transport (mounted at `/mcp`)                              | `apps/api/src/mcp.ts`                                                                                                                                                                                                                                                                    |
| Tests                                                          | `apps/api/tests/*.test.ts` (colocated by area: `scoring.test.ts`, `entities.test.ts`, `facts.test.ts`, …)                                                                                                                                                                                |

## Doc Maintenance

After any code change, update the relevant doc in `/docs` to reflect the change. If a new module or major feature is added, create a new doc file. Keep docs accurate — they are the primary architecture reference.

See `/docs` for:

- [architecture.md](docs/architecture.md) — system overview, request flow, module map, boot sequence, design decisions
- [ingest.md](docs/ingest.md) — transcript → atomic facts pipeline (consolidate, append, sessions, session-summary)
- [retrieval.md](docs/retrieval.md) — hybrid ranker (cosine + BM25 + entity boost), scoring, lemmatizer, entity extractor
- [storage.md](docs/storage.md) — Mongo collections, idempotent indexes, scope-aware reads, audit log
- [api.md](docs/api.md) — REST surface (`/facts`, `/recall`, `/query`, `/sessions`, `/health`, `/version`) and MCP tools at `/mcp`
- [dashboard.md](docs/dashboard.md) — Next.js inspector, design system, page map
- [configuration.md](docs/configuration.md) — env vars, `@kagami/llm` provider config, common LLM/embedding combos, MongoDB setup
- [testing.md](docs/testing.md) — vitest + mongodb-memory-server harness, what's covered, how to add tests
- [bench.md](docs/bench.md) — LongMemEval runner, headline numbers, BM25 calibration tool
