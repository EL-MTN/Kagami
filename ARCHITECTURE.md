# Kagami — Architecture Overview

Kagami ("mirror") is a personal-AI workspace housing four TypeScript projects in a single nested monorepo, developed and run together via `dev-all.sh`. The names are Japanese: **Kioku** (記憶, memory), **Kizuna** (絆, bond/relationship), **Kokoro** (心, heart/mind), and **Kansoku** (観測, observation). The workspace is one git repo; project subtrees were imported via `git subtree add` so per-project history is preserved in `git log`.

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Kagami (root)                           │
│                                                                      │
│   dev-all.sh  →  Kioku, Kokoro, Kizuna, Kansoku (all parallel)       │
└──────────────────────────────────────────────────────────────────────┘

      ┌──────────────────────────────┐
      │            Kioku             │  long-term memory store
      │  api.kioku.localhost (API)   │◄──── HTTP (recall / facts / sessions)
      │  kioku.localhost (Next.js)   │            │
      │  MongoDB                     │            │
      └──────────────────────────────┘            │
                                                  │
                                  ┌───────────────┴──────────────┐
                                  │            Kokoro            │  Telegram AI agent
                                  │  Grammy bot (long-poll)      │
                                  │  kokoro.localhost (Next.js)  │
                                  │  MongoDB                     │
                                  └──────────────────────────────┘

      ┌──────────────────────────────┐
      │            Kizuna            │  personal CRM
      │  api.kizuna.localhost (API)  │  CRM API for Kokoro (read + confirmation-gated writes)
      │  kizuna.localhost (Next.js)  │
      │  MongoDB                     │
      └──────────────────────────────┘

      ┌──────────────────────────────┐
      │           Kansoku            │  observability service (logs, traces, errors, metrics)
      │  api.kansoku.localhost (API) │◄──── HTTP push from all sibling services (fail-open shipper)
      │  kansoku.localhost (Next.js) │
      │  MongoDB                     │
      └──────────────────────────────┘
```

Dashboard and API HTTP entry points are served as HTTPS named URLs by [Portless](https://github.com/vercel-labs/portless) — see "Local hosting via Portless" below.

## How they relate

| Edge                              | Direction                          | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kokoro → Kioku                    | runtime HTTP dependency            | REST to `KIOKU_URL` (default `https://api.kioku.localhost`) via `tracedFetch` — outgoing requests carry the active W3C `traceparent` so Kioku's middleware threads them onto the same trace as the Telegram/iMessage update that triggered them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Kokoro → Kizuna                   | runtime HTTP dependency            | REST to `KIZUNA_URL` (default `https://api.kizuna.localhost`) via `tracedFetch` for CRM tools — reads call directly; writes (`logInteraction`, `createFollowup`, `resolveFollowup`, `updatePerson`) must be wrapped in `requestConfirmation` and only fire after the user taps Approve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Kizuna → Kioku/Kokoro             | none                               | exposes API; never initiates outbound calls to siblings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Kioku → anything                  | none (pull-only)                   | exposes API; never initiates outbound to siblings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| {Kioku, Kokoro, Kizuna} → Kansoku | observability push (**fail-open**) | In-process pino multistream installed by `@kagami/logger` when `KANSOKU_URL` + `KANSOKU_INGEST_TOKEN` are set. Batches log lines (250 ms / 50 events), POSTs to `${KANSOKU_URL}/v1/logs` with `x-kansoku-auth` under a 10 s per-request timeout. Bounded 5000-event ring buffer; full-jitter exponential backoff to 30 s on failure (incl. a 503 from Kansoku's write-then-ack); overflow dropped per `dropPolicy` with the count surfaced in `x-kansoku-dropped` on next success. Lines use ECS / OTel field names (`log.level`, `@timestamp`, `service.name`, `trace.id`, …); Kansoku ingest also accepts the legacy flat form. Every log line in a traced request carries `trace.id`/`span.id` via the pino mixin; `runWithSpan` emits `event.kind:"span"` lines that Kansoku folds into a `spans` collection for the trace waterfall. |
| Kansoku → anything                | none (push-only-in)                | exposes ingest + query APIs (`/v1/logs`, `/v1/tail`, `/v1/traces/:id`, `/v1/errors`); never initiates outbound to siblings. Failure of Kansoku must never cascade — every shipper is fail-open at the call site.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

There is no startup ordering constraint. The Kokoro → Kioku edge is fail-open at the client (`KiokuClientError` is caught by the AI tool layer; chat continues degraded). Closed-session transcript ingest, `rememberFact`, and location writes all fail open at the client; on failure they're queued to MongoDB (`PendingFact` for one-off writes, the existing session-ingest queue for transcripts) and flushed by Kokoro's 5-min sweeper. The Kokoro → Kizuna edge is also fail-open at the CRM tool layer (without retries). Reads (`findPeople`, `getPersonContext`, `recentInteractions`, `listMyFollowups`) call Kizuna directly; writes (`logInteraction`, `createFollowup`, `resolveFollowup`, `updatePerson`) are listed in `GATED_TOOL_NAMES` and must be wrapped in `requestConfirmation` so they only fire after the user taps Approve. `dev-all.sh` boots selected apps together under Turbo.

## Shared conventions

All four projects converge on the same stack. Tooling lives in `shared/packages/`; domain code stays per-project.

- **Language**: TypeScript (strict, ESM), Node ≥ 22
- **Package layout**: nested monorepo via npm workspaces + Turborepo. Workspace globs cover `kioku/{apps,packages}/*`, `kokoro/{apps,packages}/*`, `kizuna/{apps,packages}/*`, `kansoku/{apps,packages}/*`, and `shared/packages/*`. One root `package.json`, one root `turbo.json`, one hoisted `node_modules`.
- **Apps split**: `apps/api` (or `apps/bot`) + `apps/dashboard`
- **Shared tooling packages**: `@kagami/eslint-config` (`./base`, `./next`) and `@kagami/tsconfig` (`./base.json`, `./library.json`, `./server.json`, `./nextjs.json`, plus emit-on build presets `./server.build.json` and `./library.build.json`) at `shared/packages/`. Per-app `tsconfig.json` files extend a variant and add overrides where projects diverge — e.g. Kokoro/Kizuna add `verbatimModuleSyntax: true`, Kioku adds `esModuleInterop` + `allowImportingTsExtensions`, Kizuna/api adds `noImplicitOverride`.
- **Per-project internal packages**: Kokoro has `kokoro/packages/{shared,db,memory,kizuna,test-utils}`. Kioku, Kizuna, and Kansoku have no `packages/` directory today; their workspace globs (`kioku/packages/*`, `kizuna/packages/*`, `kansoku/packages/*` in `package.json`) are placeholders for future project-only libs.
- **Local dev hosting**: [Portless](https://github.com/vercel-labs/portless) (Vercel Labs) for stable HTTPS named `*.localhost` URLs — see below
- **Database**: MongoDB (Mongoose in Kizuna and Kokoro; raw driver in Kioku)
- **Inference**: Kioku and Kokoro reach all chat + embedding models through the workspace-shared `@kagami/llm` gateway (`createInference`) — provider/key construction (native `@ai-sdk/{anthropic,openai,xai,google}` + `@ai-sdk/openai-compatible`), full-jitter retry, same-tier fallback, per-attempt timeout, the LM-Studio `reasoning_content` repair (default-on for openai-compatible), and span+usage emission via `emitUsage`, a tailored usage-span emitter that attaches `llm.*` token fields the generic `runWithSpan` helper cannot carry. Callers keep `generateText`/`generateObject`/`embed`; tier _policy_ (Kokoro's Default/Fast/Smart) stays caller-side in `apps/bot/src/ai/provider.ts`. Like `@kagami/logger`, `@kagami/llm` is a **built** shared package (it emits `dist/` JS + `.d.ts`; `exports` map to `dist`), so services that run from compiled output (`node dist/...`) consume it without a TypeScript runtime; Turbo's `dev`/`typecheck`/`test` `dependsOn: ["^build"]` so it is compiled before any consumer resolves it.
- **Logging**: Pino, built via the workspace-shared `@kagami/logger` factory. Provides stable `service`, `component`, and `env` bindings, an `error`-key error serializer (`errorKey: "error"` + `pino.stdSerializers.err`, so raw `Error`s keep their stack), ECS / OTel field names on the wire (`log.level`, `@timestamp`, `service.{name,environment,component}`, `host.name`, `process.pid`, `trace.id`, `span.{id,parent.id}`, `error.{type,message,stack_trace}`, `message`) for off-the-shelf-collector portability — Kansoku ingest still accepts the legacy flat numeric/epoch form, so producers/consumer needn't restart in lock-step — and a TTY-based `pino-pretty` gate (pretty only on an interactive stdout or `LOG_PRETTY=1`; raw NDJSON otherwise). **There is no secret/PII redaction** — the redact path list and `imageData` censor were removed (logs are local-trust only; reintroduce before any non-localhost exposure). Each service's `logger.ts` is a thin wrapper that calls the factory with its own service/component name. From Phase 1 onward, the factory also installs the Kansoku transport so every log line ships (fail-open) to the workspace's observability service alongside stdout. `@kagami/logger` is a **built** shared package (it emits `dist/` JS + `.d.ts`; `exports` map to `dist`), so services that run from compiled output (`node dist/...`) consume it without a TypeScript runtime; Turbo's `dev`/`typecheck`/`test` `dependsOn: ["^build"]` so it is compiled before any consumer resolves it.
- **Validation**: Zod 4 schemas at boundaries (uniform across all four projects).

### Local hosting via Portless

[Portless](https://github.com/vercel-labs/portless) is a Vercel Labs reverse proxy that replaces numeric `localhost:<port>` URLs with stable, named `*.localhost` URLs over HTTPS. Each app is launched with `portless run <cmd>`; on first run Portless generates a local CA, trusts it system-wide (one-time `sudo` prompt), and binds port 443. It assigns each app an ephemeral port via the `PORT` env var and proxies HTTPS requests at the configured name to that port — meaning the framework's own listen port is no longer something you have to remember or coordinate.

Apps register their name either via a top-level `portless.json` (Kioku, Kizuna) or a `portless` field in `package.json` (Kokoro):

| Project | Component | Portless URL                    | Source of registration                                 |
| ------- | --------- | ------------------------------- | ------------------------------------------------------ |
| Kioku   | dashboard | `https://kioku.localhost`       | `portless.json` → `apps/dashboard`                     |
| Kioku   | API       | `https://api.kioku.localhost`   | `portless.json` → `apps/api`                           |
| Kizuna  | dashboard | `https://kizuna.localhost`      | `portless.json` → `apps/dashboard`                     |
| Kizuna  | API       | `https://api.kizuna.localhost`  | `portless.json` → `apps/api`                           |
| Kokoro  | dashboard | `https://kokoro.localhost`      | `apps/dashboard/package.json` → `"portless": "kokoro"` |
| Kokoro  | bot       | (no browser URL)                | `apps/bot/package.json` → `"portless": "bot.kokoro"`   |
| Kansoku | dashboard | `https://kansoku.localhost`     | `portless.json` → `apps/dashboard`                     |
| Kansoku | API       | `https://api.kansoku.localhost` | `portless.json` → `apps/api`                           |

Each app server honors Portless's injected `PORT`, falling back to its own numeric default only when run standalone. For example, in `kioku/apps/api/src/server.ts`:

```typescript
// `PORT` is injected by `portless run`; 7777 is the standalone fallback.
const PORT = Number.parseInt(process.env.PORT ?? "7777", 10);
```

So under normal `npm run dev`, Kioku doesn't actually bind to 7777 — Portless picks an ephemeral port in 4000–4999 and routes `https://api.kioku.localhost` to it. Numeric ports in this document are standalone-only fallbacks; everything that reaches the dashboard/API apps in normal use should go through the Portless URLs. Kokoro's bot dev script is also wrapped in Portless for consistency, but Telegram uses long-polling and the optional BlueBubbles webhook listens on `BLUEBUBBLES_WEBHOOK_PORT` rather than exposing a standard browser URL.

The same convention extends to inter-service config: Kizuna's dashboard reaches its API via `KIZUNA_API_URL=https://api.kizuna.localhost`, Kizuna's `.env.example` sets `GOOGLE_OAUTH_REDIRECT_URI=https://api.kizuna.localhost/oauth/google/callback`, Kokoro's `KIOKU_URL` defaults to `https://api.kioku.localhost`, and Kokoro's `KIZUNA_URL` defaults to `https://api.kizuna.localhost` (Zod defaults in `kokoro/packages/shared/src/config.ts`). The numeric-port forms only matter when running a project standalone outside Portless.

---

## Kioku — long-term memory service

**Role.** Storage and retrieval of atomic facts extracted from conversation transcripts. Optimized for temporal reasoning and multi-turn context. Designed to be consumed over HTTP by external agents.

**Layout.**

```
apps/api          Express HTTP API + MCP transport (entry: src/server.ts)
apps/dashboard    Next.js 16 inspector UI (https://kioku.localhost)
```

**Endpoints.** Both apps run under Portless: API at `https://api.kioku.localhost`, dashboard at `https://kioku.localhost`. The API server reads `PORT` (injected by Portless), falling back to `7777` only when run standalone. The dashboard reaches the API via `KIOKU_API_URL` (default `https://api.kioku.localhost`).

**HTTP API surface.**
| Method | Path | Purpose |
| ------ | ------------------- | ------------------------------------------------------ |
| GET | `/health` | liveness |
| GET | `/version` | name + version |
| GET | `/meta/categories` | enumerate fact categories used by the ingest pipeline |
| POST | `/facts` | append single fact (md5 + cosine dedup) |
| POST | `/facts/bulk` | append up to 500 facts verbatim (rate-limited per IP) |
| GET | `/facts` | list with filters (limit, offset, date range, scope) |
| GET | `/facts/count` | total fact count |
| GET | `/facts/:id` | fetch one |
| GET | `/facts/:id/history`| audit log for fact |
| POST | `/recall` | hybrid retrieval (cosine + BM25 + entity boost), no LLM |
| POST | `/query` | answer a question using top-K facts |
| POST | `/sessions` | ingest raw transcript, extract + embed facts (rate-limited per IP) |

An MCP transport at `/mcp` exposes the same operations as 7 tools (`recall`, `query`, `append_fact`, `append_facts`, `ingest_session`, `fact_count`, `fact_history`).

**Storage.** MongoDB collections: `facts` (with `$vectorSearch` HNSW + `$search` BM25 indexes), `entities`, `transcripts`, `session_summaries`, `history`. Facts are scoped by `(user_id, run_id, agent_id)` — no auth layer; multi-tenancy is filter-based.

**External services.** OpenAI-compatible LLM (default LM Studio at `http://localhost:1234/v1`) and a separately-configured embedding provider (default nomic-embed), both reached through the shared `@kagami/llm` gateway (`kind: "openai-compatible"`; `reasoning_content` repair default-on). Both pluggable via `LLM_*` / `EMBEDDING_*` env vars.

**Coupling notes.** No code references to Kokoro or Kizuna. Pull-only by design. The dashboard CSS contains a stray comment referencing a "Warm-paper light theme inherited from Kokoro" — the only cross-project trace, and cosmetic.

---

## Kokoro — Telegram AI agent

**Role.** A personal conversational AI agent fronted by Telegram (with optional iMessage via BlueBubbles). Maintains personality from a `soul.md` file and supports tool-calling, scheduled routines, and stateful watchers. Persistent memory is delegated to Kioku; relationship context is delegated to Kizuna (reads are direct, writes are confirmation-gated).

**Layout.**

```
apps/bot          Grammy-based Telegram bot (entry: src/index.ts)
apps/dashboard    Next.js 16 dashboard (https://kokoro.localhost)
packages/shared   Zod config, logger, platform types
packages/db       Mongoose models, GridFS for images
packages/memory   Kioku HTTP client + transcript glue
packages/kizuna   Kizuna CRM client (read + confirmation-gated writes) + compact projections
packages/test-utils
```

**Endpoints.** The Telegram bot long-polls and has no normal browser URL. Its dev script is still wrapped in Portless via the `"portless": "bot.kokoro"` field in `apps/bot/package.json`; optional BlueBubbles support starts an HTTP webhook on `BLUEBUBBLES_WEBHOOK_PORT` (default 4000) for inbound iMessage events. Dashboard runs under Portless at `https://kokoro.localhost` (registered via the `"portless": "kokoro"` field in `apps/dashboard/package.json`).

**Dashboard API.** Next.js route handlers under `/api/`:

- `routines/` — scheduled prompts (CRUD, import/export JSON, run, logs)
- `watchers/` — stateful detection jobs (CRUD, import/export JSON, run, logs)
- `images/[key]` — GridFS image fetch

**Kioku client.** All calls live in `packages/memory/src/index.ts`. Base URL from `KIOKU_URL` (default `https://api.kioku.localhost`; use `http://localhost:7777` only for standalone Kioku runs outside Portless):
| Method | Path | Used for | Timeout |
| ------ | ---------------------------- | --------------------------------------- | ------- |
| POST | `/recall` | bot tool: search memory | 10 s |
| POST | `/facts` | bot tool / location updates: save fact | 10 s |
| GET | `/facts/:id` | fetch by id | 10 s |
| GET | `/facts?source_session=...` | sweeper dedup probe | 10 s |
| GET | `/facts/count` | health/stats | 10 s |
| POST | `/sessions` | full transcript ingest (LLM extraction) | 180 s |

Failure mode is **fail-open** via `KiokuClientError`: chat continues degraded. The 5-minute sweeper in `apps/bot/src/scheduler/maintenance.ts` provides durable retry for all writes: closed-session transcript ingest (`sweepPendingIngests`, `sweepStaleActiveSessions`) and one-off fact writes (`sweepPendingFacts`). `rememberFact` and location updates go through `appendFactWithRetryQueue`, which enqueues failed appends to the `PendingFact` collection for the sweeper to flush.

**Kizuna client.** CRM calls live in `packages/kizuna/src/` and are exposed to the LLM through `apps/bot/src/ai/tools/crm.ts`. Base URL comes from `KIZUNA_URL` (default `https://api.kizuna.localhost`) and the tool palette is gated by `KIZUNA_ENABLED` (default `true`):

| Method | Path                                            | Used for                                         | Timeout                   |
| ------ | ----------------------------------------------- | ------------------------------------------------ | ------------------------- |
| GET    | `/people?identityQuery=...`                     | bot tool: identity-focused people search         | shared 10 s call deadline |
| GET    | `/people/:id`                                   | bot tool: person profile context                 | shared 10 s call deadline |
| GET    | `/interactions?personId=...&sort=occurredAt:-1` | bot tool: recent interactions                    | shared 10 s call deadline |
| GET    | `/people/:id/interactions?sort=occurredAt:-1`   | person-context hydration                         | shared 10 s call deadline |
| GET    | `/followups?sort=duePriority:1`                 | bot tool: followups, with person hydration       | shared 10 s call deadline |
| POST   | `/interactions`                                 | bot tool: `logInteraction` (confirmation-gated)  | shared 10 s call deadline |
| POST   | `/followups`                                    | bot tool: `createFollowup` (confirmation-gated)  | shared 10 s call deadline |
| PATCH  | `/followups/:id`                                | bot tool: `resolveFollowup` (confirmation-gated) | shared 10 s call deadline |
| PATCH  | `/people/:id`                                   | bot tool: `updatePerson` (confirmation-gated)    | shared 10 s call deadline |

Reads are called directly; writes are listed in `GATED_TOOL_NAMES` and must be wrapped in `requestConfirmation` (Telegram tap-to-approve, iMessage YES/NO). Failure mode is **fail-open** via `KizunaClientError`: read tools return sanitized degraded results and chat continues; the gated dispatcher surfaces failures back to the user via the prompt edit and acknowledgment turn. There is no auth header; Kizuna is treated as a single-user localhost service.

**Storage.** MongoDB models: `Conversation`, `Routine`, `Watcher`, `Reminder`, `PendingConfirmation`, `PendingFact`, `SchedulerState`, `TokenUsage`, `LocationHistory`. GridFS for images.

**External services.** Anthropic / xAI / OpenAI chat LLMs via the shared `@kagami/llm` gateway (`kind: "native"`; tier policy stays in `apps/bot/src/ai/provider.ts`); Google AI SDK for image generation only, still via the Vercel AI SDK directly; ElevenLabs TTS; Whisper STT (local or OpenAI); Stagehand / Browserbase for browser automation; Google OAuth (Gmail, Calendar, Maps); Brave Search. Embeddings are not computed by Kokoro — they're delegated to Kioku.

**Auth model.** Single-user-per-deployment; Telegram user IDs are gated via `ALLOWED_USER_IDS` when set — note that an empty/unset `ALLOWED_USER_IDS` disables gating (the middleware lets every chat through), so a real deployment must populate it. Google access uses a long-lived refresh token from env (not DB).

**Coupling notes.** Heavily coupled to Kioku (file references in `packages/memory/`, `apps/bot/src/ai/tools/memory.ts`, `apps/bot/src/services/location.ts`, `apps/bot/src/scheduler/maintenance.ts`). Coupled to Kizuna through `packages/kizuna/` and `apps/bot/src/ai/tools/crm.ts` — reads call Kizuna directly; writes (`logInteraction`, `createFollowup`, `resolveFollowup`, `updatePerson`) are dispatched from `apps/bot/src/services/gated-actions.ts` only after user approval.

---

## Kizuna — personal CRM

**Role.** Tracks people, organizations, interactions, and follow-ups. Auto-ingests from Google Gmail and Calendar to populate the relationship graph. The API is consumed by the dashboard and by Kokoro's CRM tools (reads call directly; writes go through Kokoro's confirmation primitive).

**Layout.**

```
apps/api          Express API (entry: src/main.ts)
apps/dashboard    Next.js 16 app (App Router; pages live flat under src/app/{today,contexts,errors,followups,interactions,people,sync,tombstones})
packages/         (no directory today — workspace glob is a placeholder for future Kizuna-only libs)
```

**Endpoints.** Both apps run under Portless: API at `https://api.kizuna.localhost`, dashboard at `https://kizuna.localhost`. Portless injects each process's `PORT` and proxies the named HTTPS URLs to those ephemeral ports; the API's `3000` fallback only matters when running it standalone outside Portless. The checked-in `.env.example` uses `GOOGLE_OAUTH_REDIRECT_URI=https://api.kizuna.localhost/oauth/google/callback`, so the redirect lands on the Portless HTTPS origin.

**HTTP API surface.** Open at single-user localhost — no bearer auth on resource routes, no auth on `/oauth/google/{start,status}`. The OAuth callback is still CSRF-protected by a signed state token (process-local HMAC secret).

| Group         | Endpoints                                                                          |
| ------------- | ---------------------------------------------------------------------------------- |
| Health        | `GET /health`                                                                      |
| People        | `GET/POST /people`, `GET/PATCH/DELETE /people/:id`, `GET /people/:id/interactions` |
| Interactions  | `GET/POST /interactions`, `DELETE /interactions/:id`                               |
| Followups     | `GET/POST /followups`, `PATCH/DELETE /followups/:id`                               |
| Organizations | `GET/POST /organizations`, `GET/PATCH/DELETE /organizations/:id`                   |
| Contexts      | `GET /contexts` (distinct tags + counts)                                           |
| Digest        | `GET /digest?window=P7D`                                                           |
| Sync          | `GET /sync/{gmail,gcal}/state`, `POST /sync/{gmail,gcal}/run`                      |
| OAuth         | `/oauth/google/{start,callback,status}`                                            |

**Storage.** Mongoose models: `Person`, `Interaction`, `Followup`, `Organization`, `OAuthToken` (AES-256-GCM-encrypted refresh tokens), `SyncState`. Text indexes on people/interactions; unique sourceRef per Gmail/Calendar id.

**External services.** Google Gmail API (`gmail.readonly`) and Calendar API (`calendar.readonly`) via google-auth-library. No LLM, no queue, no webhooks.

**Auth model.** Single-user localhost; the OS user is the trust boundary. No API auth, no dashboard login. `USER_EMAILS` is used by the ingest workers to identify which inbox addresses count as "self" (not for auth). Refresh tokens are AES-256-GCM-encrypted at rest under `KIZUNA_OAUTH_ENCRYPTION_KEY`. See `kizuna/docs/auth.md` for the threat model.

**Coupling notes.** Kizuna has zero outbound references to Kioku or Kokoro. It is built and run independently of the other two; Kokoro consumes its API over HTTP when `KIZUNA_ENABLED` is true.

---

## Kansoku — observability service

**Role.** Centralized observability for the workspace: structured logs, distributed traces, fingerprinted errors, and metrics. Every sibling service pushes events via a fail-open Pino transport added to `@kagami/logger`; the dashboard surfaces live tail, search, single-trace waterfalls, and grouped errors. **Push-only-in** — Kansoku never initiates outbound calls to siblings.

**Layout.**

```
apps/api          Express API (entry: src/server.ts) — full surface: meta, ingest, query, tail (SSE), errors, services
apps/dashboard    Next.js 16 app — overview / tail / search / traces / errors / services
packages/         (no directory today — workspace glob is a placeholder for future Kansoku-only libs)
```

**Endpoints.** Both apps run under Portless: API at `https://api.kansoku.localhost`, dashboard at `https://kansoku.localhost`. Standalone fallback port is `7779`.

| Group       | Endpoints                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Health/meta | `GET /health` (liveness), `GET /ready` (Mongo ping), `GET /version`                                              |
| Ingest      | `POST /v1/logs` (HMAC-token-authed via `KANSOKU_INGEST_TOKEN`)                                                   |
| Query       | `GET /v1/logs`, `GET /v1/traces/:id`, `GET /v1/errors`, `GET /v1/services`, `GET /v1/services/:service/timeline` |
| Live tail   | `GET /v1/tail` (SSE)                                                                                             |

**Storage.** MongoDB time-series `logs` collection with `timeField: ts`, `metaField: { service, component, env, level }`; a regular `errors` collection keyed by fingerprint; a regular `spans` collection (`_id = traceId:spanId`) folded from build-light `event.kind:"span"` log lines, driving the trace waterfall. Retention: `KANSOKU_LOGS_TTL_DAYS` (default 30, capped 365) for the time-series collection, `KANSOKU_ERRORS_TTL_DAYS` (default 90, capped 365) for the errors registry (TTL on `errors_last_seen` — quiet fingerprints age out), and the logs TTL applied to `spans` (`startedAt`). A `KANSOKU_MAX_META_COMBOS` budget (default 1000) caps time-series bucket cardinality against a buggy producer. A `metrics` time-series collection is reserved for an explicit metric-push API, but is not created — derived metrics aggregate over `logs`.

**Auth model.** Single-user localhost; the OS user is the trust boundary. The ingest endpoint requires a shared HMAC token in the `x-kansoku-auth` header (constant-time byte-length comparison). Read endpoints (query, tail, errors, services) are unauthenticated.

**Coupling notes.** Kansoku has zero outbound references to siblings — except an optional fail-open `POST` to `KANSOKU_ALERT_WEBHOOK_URL` when a brand-new error fingerprint shows up (typically Discord / Slack-shaped). Inbound coupling is the inverse of Kioku's posture: every other service pushes to Kansoku via the shared `@kagami/logger` transport. Failure of Kansoku must never cascade — shippers buffer in-memory, drop per `dropPolicy` on overflow, and back off (full jitter) rather than blocking the caller; ingest is write-then-ack so a Mongo outage requeues into that buffer instead of silently losing the batch.

See `kansoku/docs/architecture.md` for the full ingest path, data model, dashboard surfaces, and phased delivery plan.

---

## Running the projects together

`dev-all.sh` at the repo root:

1. Prints the Portless URL banner for the active components.
2. Hands off via `exec` to `turbo run dev` with one `--filter` per active app.
3. Uses Turbo's TUI when stdout is a TTY (per-task panes, scrollback, single Ctrl-C); falls back to streamed `[prefix]` output when piped or redirected.

There is no ordering between the projects — see "How they relate" above. Selective flags: `--only <target>...` and `--no <target>...`, where `<target>` is a project (`kioku`, `kokoro`, `kizuna`, `kansoku`) or a single component (`kokoro:bot`, `kioku:dashboard`, `kansoku:api`, ...). `--stream` forces streamed output even on a TTY.

## Configuration cheat sheet

| Project | Critical env vars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kioku   | `KIOKU_MONGO_URI`, `LLM_*`, `EMBEDDING_*`, `KIOKU_API_URL` (dashboard → API; default `https://api.kioku.localhost`); port handled by Portless (`PORT`/`KIOKU_HOST` only for standalone runs)                                                                                                                                                                                                                                                                                                                                                                     |
| Kokoro  | `TELEGRAM_BOT_TOKEN`, `MONGODB_URI`, `KIOKU_URL` (→ `https://api.kioku.localhost`), `KIZUNA_URL` (→ `https://api.kizuna.localhost`), `KIZUNA_ENABLED`, `LLM_PROVIDER`/`LLM_MODEL`, provider API keys, `GOOGLE_OAUTH_*`                                                                                                                                                                                                                                                                                                                                           |
| Kizuna  | `MONGO_URI`, `USER_EMAILS`, `KIZUNA_API_URL` (→ `https://api.kizuna.localhost`), `GOOGLE_OAUTH_*` (redirect URI → `https://api.kizuna.localhost/oauth/google/callback`), `KIZUNA_OAUTH_ENCRYPTION_KEY`, `KIZUNA_HOST` (standalone fallback)                                                                                                                                                                                                                                                                                                                      |
| Kansoku | `KANSOKU_MONGO_URI`, `KANSOKU_MONGO_DB`, `KANSOKU_INGEST_TOKEN` (shared HMAC for sibling shippers), `KANSOKU_API_URL` (dashboard → API; default `https://api.kansoku.localhost`), `KANSOKU_LOGS_TTL_DAYS` (time-series TTL; default 30, capped 365), `KANSOKU_ERRORS_TTL_DAYS` (errors-registry TTL; default 90, capped 365), `KANSOKU_MAX_META_COMBOS` (meta cardinality budget; default 1000), `KANSOKU_ALERT_WEBHOOK_URL` (optional new-error webhook); `LOG_PRETTY` (TTY/`1`/`0` console gate, all services); `PORT`/`KANSOKU_HOST` only for standalone runs |

## Observed gaps and likely future edges

- **Kokoro → Kizuna writes** are now live behind the confirmation primitive (`logInteraction`, `createFollowup`, `resolveFollowup`, `updatePerson`). Remaining write candidates — bulk imports, organization edits, ingest replays from Kokoro — are still gaps.
- **Kizuna ↔ Kioku** would let Kizuna's interaction timeline feed Kioku's fact store, but again no code path exists today.
- Kioku and Kizuna both implement Google OAuth independently; a shared token store is a candidate for consolidation but is not implemented.
