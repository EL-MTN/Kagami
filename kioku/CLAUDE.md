# CLAUDE.md

## Project

Kioku — a personal long-term memory subsystem. Atomic facts in MongoDB + hybrid retrieval (`$vectorSearch` + `$search` + entity boost) + a single MCP server interface. Designed to be consumed over HTTP by external agents (Kokoro is the primary client). Built with TypeScript, Express, the Vercel AI SDK (`@ai-sdk/openai-compatible`), and a Next.js dashboard for inspection. Lives as a subtree inside the Kagami nested monorepo.

## Monorepo Structure

```
kioku/                # subtree of the Kagami workspace; no project-local package.json / turbo.json
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
│   │   ├── tsconfig.json    # extends @kagami/tsconfig/server.json (+ esModuleInterop, allowImportingTsExtensions)
│   │   ├── eslint.config.js # imports from @kagami/eslint-config/base
│   │   └── bench/longmemeval/  # benchmark runner + datasets + results
│   └── dashboard/    # Next.js 15 inspector at https://kioku.localhost
│       ├── tsconfig.json    # extends @kagami/tsconfig/nextjs.json (+ esModuleInterop)
│       └── eslint.config.js # imports from @kagami/eslint-config/base
├── portless.json     # api.kioku + kioku Portless registrations
└── docs/
```

**Stack**: Kioku is a *subtree* inside the Kagami nested monorepo. The Kagami workspace root owns `package.json`, `turbo.json`, and `package-lock.json`; npm workspaces and Turborepo span all three sibling projects. Tooling is shared via the workspace-level `@kagami/eslint-config` and `@kagami/tsconfig` packages (which live in `shared/packages/` at the Kagami root). Kioku has no project-internal TypeScript packages today — `kioku/packages/` is empty (or absent). Apps depend on each other only via HTTP (the dashboard calls the API at `KIOKU_API_URL`).

## Commands

All commands run from the **Kagami workspace root** (`/Users/mastermind/Desktop/Programming/Kagami/`). To work on Kioku in isolation, use the `kioku:*` script aliases.

```bash
# From Kagami root:
./dev-all.sh                  # boot all three (Kioku → Kokoro + Kizuna) with prefixed output
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
npx turbo run build    --filter="@kioku/*"   # dashboard only — api has no build step
```

Apps run under [Portless](https://github.com/vercel-labs/portless) at `https://kioku.localhost` (dashboard) and `https://api.kioku.localhost` (API). HTTPS is auto-trusted; first run prompts once for sudo to install the local CA. Portless injects `PORT`; `7777` is the standalone fallback for the API.

The benchmark runner lives at `apps/api/bench/longmemeval/README.md` — see [bench.md](docs/bench.md).

## Dependency Graph

```
@kagami/eslint-config, @kagami/tsconfig (workspace-shared, live in shared/packages/)
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
- **Cross-package imports** — `@kagami/eslint-config`, `@kagami/tsconfig` only (no project-internal packages today); no cross-app TS imports.
- **Within-package imports** — relative paths with explicit `.js` extensions (NodeNext requirement on the API).
- **Internal packages pattern** — Kioku has no project-internal TS packages today. The apps consume only the shared `@kagami/*` config packages from the Kagami workspace root (`shared/packages/`); the former `kioku/packages/typescript-config` and `kioku/packages/eslint-config` were folded into those workspace-level packages during the Kagami migration.

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
