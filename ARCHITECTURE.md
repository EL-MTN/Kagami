# Kagami — Architecture Overview

Kagami ("mirror") is a personal-AI workspace housing three TypeScript projects in a single nested monorepo, developed and run together via `dev-all.sh`. The names are Japanese: **Kioku** (記憶, memory), **Kizuna** (絆, bond/relationship), **Kokoro** (心, heart/mind). The workspace is one git repo; project subtrees were imported via `git subtree add` so per-project history is preserved in `git log`.

```
┌────────────────────────────────────────────────────────────────┐
│                          Kagami (root)                         │
│                                                                │
│   dev-all.sh  →  Kioku → (sleep 2) → Kokoro + Kizuna           │
└────────────────────────────────────────────────────────────────┘

      ┌──────────────────────────────┐
      │            Kioku             │  long-term memory store
      │  api.kioku.localhost (API)   │◄──── HTTP (recall / facts / sessions)
      │  kioku.localhost (Next.js)   │            │
      │  MongoDB                     │            │
      └──────────────────────────────┘            │
                                                  │
                                  ┌───────────────┴──────────────┐
                                  │            Kokoro            │  Telegram AI agent
                                  │  Grammy bot (no HTTP server) │
                                  │  kokoro.localhost (Next.js)  │
                                  │  MongoDB                     │
                                  └──────────────────────────────┘

      ┌──────────────────────────────┐
      │            Kizuna            │  personal CRM (standalone)
      │  api.kizuna.localhost (API)  │  no link to Kioku or Kokoro
      │  kizuna.localhost (Next.js)  │
      │  MongoDB                     │
      └──────────────────────────────┘
```

All HTTP entry points are served as HTTPS named URLs by [Portless](https://github.com/vercel-labs/portless) — see "Local hosting via Portless" below.

## How they relate

| Edge                  | Direction                  | Mechanism                                |
| --------------------- | -------------------------- | ---------------------------------------- |
| Kokoro → Kioku        | runtime HTTP dependency    | REST to `KIOKU_URL`, which defaults to the Portless API host `https://api.kioku.localhost`. |
| Kokoro → Kizuna       | none                       | no references in code                    |
| Kizuna → Kioku/Kokoro | none                       | no references in code                    |
| Kioku → anything      | none (pull-only)           | exposes API; never initiates outbound to siblings |

`dev-all.sh` enforces the only real ordering constraint: Kioku must be up before Kokoro starts, otherwise Kokoro's first memory calls fail open and lose data until retried by the sweeper.

## Shared conventions

All three projects converge on the same stack. Tooling lives in `shared/packages/`; domain code stays per-project.

- **Language**: TypeScript (strict, ESM), Node ≥ 22
- **Package layout**: nested monorepo via npm workspaces + Turborepo. Workspace globs cover `kioku/{apps,packages}/*`, `kokoro/{apps,packages}/*`, `kizuna/{apps,packages}/*`, and `shared/packages/*`. One root `package.json`, one root `turbo.json`, one hoisted `node_modules`.
- **Apps split**: `apps/api` (or `apps/bot`) + `apps/dashboard`
- **Shared tooling packages**: `@kagami/eslint-config` (`./base`, `./next`) and `@kagami/tsconfig` (`./base.json`, `./library.json`, `./server.json`, `./nextjs.json`) at `shared/packages/`. Per-app `tsconfig.json` files extend a variant and add overrides where projects diverge — e.g. Kokoro/Kizuna add `verbatimModuleSyntax: true`, Kioku adds `esModuleInterop` + `allowImportingTsExtensions`, Kizuna/api adds `noImplicitOverride`.
- **Per-project internal packages**: only Kokoro has them today (`kokoro/packages/{shared,db,memory,test-utils}`). Kioku and Kizuna have empty `packages/` slots reserved for future project-only libs.
- **Local dev hosting**: [Portless](https://github.com/vercel-labs/portless) (Vercel Labs) for stable HTTPS named `*.localhost` URLs — see below
- **Database**: MongoDB (Mongoose in Kizuna and Kokoro; raw driver in Kioku)
- **Logging**: Pino
- **Validation**: Zod schemas at boundaries. Note the version split: Kioku/api and Kizuna/api use `zod ^3.x` (hoisted at root); Kokoro/bot uses `zod ^4.x` (installed locally inside `kokoro/apps/bot/node_modules`). Kokoro/bot's `tsconfig.json` includes a `paths` mapping to redirect `zod` resolution to its local copy so TypeScript sees v4 types when compiling bot code.

### Local hosting via Portless

[Portless](https://github.com/vercel-labs/portless) is a Vercel Labs reverse proxy that replaces numeric `localhost:<port>` URLs with stable, named `*.localhost` URLs over HTTPS. Each app is launched with `portless run <cmd>`; on first run Portless generates a local CA, trusts it system-wide (one-time `sudo` prompt), and binds port 443. It assigns each app an ephemeral port via the `PORT` env var and proxies HTTPS requests at the configured name to that port — meaning the framework's own listen port is no longer something you have to remember or coordinate.

Apps register their name either via a top-level `portless.json` (Kioku, Kizuna) or a `portless` field in `package.json` (Kokoro's dashboard):

| Project | Component | Portless URL                  | Source of registration                |
| ------- | --------- | ----------------------------- | ------------------------------------- |
| Kioku   | dashboard | `https://kioku.localhost`     | `portless.json` → `apps/dashboard`    |
| Kioku   | API       | `https://api.kioku.localhost` | `portless.json` → `apps/api`          |
| Kizuna  | dashboard | `https://kizuna.localhost`    | `portless.json` → `apps/dashboard`    |
| Kizuna  | API       | `https://api.kizuna.localhost`| `portless.json` → `apps/api`          |
| Kokoro  | dashboard | `https://kokoro.localhost`    | `apps/dashboard/package.json` → `"portless": "kokoro"` |
| Kokoro  | bot       | (none — Telegram long-poll)   | no HTTP listener                      |

Each app server honors Portless's injected `PORT`, falling back to its own numeric default only when run standalone. For example, in `kioku/apps/api/src/server.ts`:

```typescript
// `PORT` is injected by `portless run`; 7777 is the standalone fallback.
const PORT = Number.parseInt(process.env.PORT ?? "7777", 10);
```

So under normal `npm run dev`, Kioku doesn't actually bind to 7777 — Portless picks an ephemeral port in 4000–4999 and routes `https://api.kioku.localhost` to it. The numeric defaults in this document (Kioku 7777, Kizuna 3000 / 3001) are only the standalone-fallback values; everything that reaches the apps in normal use goes through the Portless URLs.

The same convention extends to inter-service config: Kizuna's dashboard reaches its API via `KIZUNA_API_URL=https://api.kizuna.localhost`, Kizuna's Google OAuth uses `GOOGLE_OAUTH_REDIRECT_URI=https://api.kizuna.localhost/oauth/google/callback`, and Kokoro's `KIOKU_URL` defaults to `https://api.kioku.localhost` (Zod default in `kokoro/packages/shared/src/config.ts`). The numeric-port forms only matter when running a project standalone outside Portless.

---

## Kioku — long-term memory service

**Role.** Storage and retrieval of atomic facts extracted from conversation transcripts. Optimized for temporal reasoning and multi-turn context. Designed to be consumed over HTTP by external agents.

**Layout.**
```
apps/api          Express HTTP API + MCP transport (entry: src/server.ts)
apps/dashboard    Next.js 15 inspector UI (https://kioku.localhost)
```

**Endpoints.** Both apps run under Portless: API at `https://api.kioku.localhost`, dashboard at `https://kioku.localhost`. The API server reads `PORT` (injected by Portless), falling back to `7777` only when run standalone. The dashboard reaches the API via `KIOKU_API_URL` (default `https://api.kioku.localhost`).

**HTTP API surface.**
| Method | Path                | Purpose                                                |
| ------ | ------------------- | ------------------------------------------------------ |
| GET    | `/health`           | liveness                                               |
| GET    | `/version`          | name + version                                         |
| POST   | `/facts`            | append single fact (md5 + cosine dedup)                |
| POST   | `/facts/bulk`       | append up to 500 facts verbatim                        |
| GET    | `/facts`            | list with filters (limit, offset, date range, scope)   |
| GET    | `/facts/count`      | total fact count                                       |
| GET    | `/facts/:id`        | fetch one                                              |
| GET    | `/facts/:id/history`| audit log for fact                                     |
| POST   | `/recall`           | hybrid retrieval (cosine + BM25 + entity boost), no LLM |
| POST   | `/query`            | answer a question using top-K facts                    |
| POST   | `/sessions`         | ingest raw transcript, extract + embed facts           |

An MCP transport at `/mcp` exposes the same operations as 7 tools (`recall`, `query`, `append_fact`, `append_facts`, `ingest_session`, `fact_count`, `fact_history`).

**Storage.** MongoDB collections: `facts` (with `$vectorSearch` HNSW + `$search` BM25 indexes), `entities`, `transcripts`, `session_summaries`, `history`. Facts are scoped by `(user_id, run_id, agent_id)` — no auth layer; multi-tenancy is filter-based.

**External services.** OpenAI-compatible LLM (default LM Studio at `http://localhost:1234/v1`) and a separately-configured embedding provider (default nomic-embed). Both pluggable via `LLM_*` / `EMBEDDING_*` env vars.

**Coupling notes.** No code references to Kokoro or Kizuna. Pull-only by design. The dashboard CSS contains a stray comment referencing a "Warm-paper light theme inherited from Kokoro" — the only cross-project trace, and cosmetic.

---

## Kokoro — Telegram AI agent

**Role.** A personal conversational AI agent fronted by Telegram (with optional iMessage via BlueBubbles). Maintains personality from a `soul.md` file and supports tool-calling, scheduled routines, and stateful watchers. Persistent memory is delegated to Kioku.

**Layout.**
```
apps/bot          Grammy-based Telegram bot (entry: src/index.ts)
apps/dashboard    Next.js 15 dashboard (https://kokoro.localhost)
packages/shared   Zod config, logger, platform types
packages/db       Mongoose models, GridFS for images
packages/memory   Kioku HTTP client + transcript glue
packages/test-utils
```

**Endpoints.** Bot has **no HTTP server** — it long-polls Telegram and so doesn't need Portless. Optional BlueBubbles webhook listens on `BLUEBUBBLES_WEBHOOK_PORT` (default 4000) for inbound iMessage events. Dashboard runs under Portless at `https://kokoro.localhost` (registered via the `"portless": "kokoro"` field in `apps/dashboard/package.json`).

**Dashboard API.** Next.js route handlers under `/api/`:
- `routines/` — scheduled prompts (CRUD, import/export YAML, run, logs)
- `watchers/` — stateful detection jobs (CRUD, import/export, run, logs)
- `images/[key]` — GridFS image fetch

**Kioku client.** All calls live in `packages/memory/src/index.ts`. Base URL from `KIOKU_URL` (default `http://localhost:7777`):
| Method | Path                         | Used for                                | Timeout |
| ------ | ---------------------------- | --------------------------------------- | ------- |
| POST   | `/recall`                    | bot tool: search memory                 | 10 s    |
| POST   | `/facts`                     | bot tool / location updates: save fact  | 10 s    |
| GET    | `/facts/:id`                 | fetch by id                             | 10 s    |
| GET    | `/facts?source_session=...`  | sweeper dedup probe                     | 10 s    |
| GET    | `/facts/count`               | health/stats                            | 10 s    |
| POST   | `/sessions`                  | full transcript ingest (LLM extraction) | 180 s   |

Failure mode is **fail-open** via `KiokuClientError`: chat continues degraded, and `apps/bot/src/scheduler/maintenance.ts` runs a 5-minute sweeper (`sweepPendingIngests`, `sweepStaleActiveSessions`) to retry.

**Storage.** MongoDB models: `Conversation`, `Routine`, `Watcher`, `Reminder`, `PendingConfirmation`, `SchedulerState`, `TokenUsage`, `LocationHistory`. GridFS for images.

**External services.** Anthropic / xAI / OpenAI / Google (LLMs and embeddings) via Vercel AI SDK; ElevenLabs TTS; Whisper STT (local or OpenAI); Stagehand / Browserbase for browser automation; Google OAuth (Gmail, Calendar, Maps); Brave Search.

**Auth model.** Single-user-per-deployment; Telegram user IDs gated via `ALLOWED_USER_IDS`. Google access uses a long-lived refresh token from env (not DB).

**Coupling notes.** Heavily coupled to Kioku (file references in `packages/memory/`, `apps/bot/src/ai/tools/memory.ts`, `apps/bot/src/services/location.ts`, `apps/bot/src/scheduler/maintenance.ts`). **No references to Kizuna** anywhere.

---

## Kizuna — personal CRM

**Role.** Tracks people, organizations, interactions, and follow-ups. Auto-ingests from Google Gmail and Calendar to populate the relationship graph. Self-contained; not currently wired into the rest of Kagami.

**Layout.**
```
apps/api          Express API (entry: src/main.ts)
apps/dashboard    Next.js 15 app (App Router, with /(app) and /(auth) groups)
packages/eslint-config
packages/typescript-config
```

**Endpoints.** Both apps run under Portless: API at `https://api.kizuna.localhost`, dashboard at `https://kizuna.localhost`. The processes bind to `:3000` and `:3001` respectively (the Google OAuth redirect URI defaults to `https://api.kizuna.localhost/oauth/google/callback`, going through the Portless proxy so the redirect lands on a real HTTPS origin).

**HTTP API surface.** All `/v1/*` endpoints require Bearer auth via `KIZUNA_API_KEY`; OAuth handlers use a key-query fallback or signed CSRF.

| Group         | Endpoints |
| ------------- | --------- |
| People        | `GET/POST /v1/people`, `PATCH/DELETE /v1/people/:id` |
| Interactions  | `GET/POST /v1/interactions`, `DELETE /v1/interactions/:id` |
| Followups     | `GET /v1/followups`, `PATCH /v1/followups/:id` |
| Organizations | `GET/POST /v1/organizations`, `PATCH/DELETE /v1/organizations/:id` |
| Contexts      | `GET /v1/contexts` (distinct tags + counts) |
| Digest        | `GET /v1/digest?window=P7D` |
| Sync          | `GET/POST /v1/sync/{gmail,gcal}/{state,run}` |
| OAuth         | `/oauth/google/{start,callback,status}` |
| Manifest      | `GET /v1/_manifest` (OpenAPI-like) |

**Storage.** Mongoose models: `Person`, `Interaction`, `Followup`, `Organization`, `OAuthToken` (AES-256-GCM-encrypted refresh tokens), `SyncState`. Text indexes on people/interactions; unique sourceRef per Gmail/Calendar id.

**External services.** Google Gmail API (`gmail.readonly`) and Calendar API (`calendar.readonly`) via google-auth-library. No LLM, no queue, no webhooks.

**Auth model.** Allowlist via `USER_EMAILS`. Dashboard sessions are HMAC-signed cookies derived from `KIZUNA_API_KEY` (30-day TTL). API consumers use the same key as a Bearer token.

**Coupling notes.** Zero references to Kioku or Kokoro (verified by grep). Built and run independently of the other two; included in `dev-all.sh` only for convenience.

---

## Running the three together

`dev-all.sh` at the repo root:

1. Verifies each project directory has a `package.json`.
2. Starts Kioku, sleeps 2 s, then starts Kokoro and Kizuna in parallel.
3. Prefixes each project's stdout/stderr with `[Kioku]`, `[Kokoro]`, `[Kizuna]`.
4. Forwards SIGINT/SIGTERM to all three.

The 2-second pause is the script's only acknowledgement of the Kokoro→Kioku dependency. In practice Kokoro tolerates Kioku starting later (fail-open + sweeper), but the sequence keeps the first memory operations clean.

## Configuration cheat sheet

| Project | Critical env vars                                                            |
| ------- | ---------------------------------------------------------------------------- |
| Kioku   | `KIOKU_MONGO_URI`, `LLM_*`, `EMBEDDING_*`, `KIOKU_API_URL` (dashboard → API; default `https://api.kioku.localhost`); port handled by Portless (`PORT`/`KIOKU_HOST` only for standalone runs) |
| Kokoro  | `TELEGRAM_BOT_TOKEN`, `MONGODB_URI`, `KIOKU_URL` (→ `https://api.kioku.localhost`), `LLM_PROVIDER`/`LLM_MODEL`, provider API keys, `GOOGLE_OAUTH_*` |
| Kizuna  | `KIZUNA_API_KEY`, `MONGO_URI`, `USER_EMAILS`, `KIZUNA_API_URL` (→ `https://api.kizuna.localhost`), `GOOGLE_OAUTH_*` (redirect URI → `https://api.kizuna.localhost/oauth/google/callback`), `KIZUNA_OAUTH_ENCRYPTION_KEY` |

## Observed gaps and likely future edges

- **Kizuna ↔ Kokoro** would be a natural next edge: Kizuna already structures person/interaction data that Kokoro could surface during conversations, and Kokoro could log Telegram/iMessage interactions back into Kizuna. No such wiring exists yet.
- **Kizuna ↔ Kioku** would let Kizuna's interaction timeline feed Kioku's fact store, but again no code path exists today.
- Kioku and Kizuna both implement Google OAuth independently; a shared token store is a candidate for consolidation but is not implemented.
