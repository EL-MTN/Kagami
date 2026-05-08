# Kagami

Kagami is a personal-AI workspace that brings three bounded TypeScript projects into one
nested monorepo:

- **Kioku**: long-term memory service with REST and MCP surfaces.
- **Kokoro**: Telegram-first personal AI agent with tools, routines, watchers, and dashboards.
- **Kizuna**: personal CRM for people, organizations, interactions, follow-ups, Gmail, and
  Calendar ingest.

The root workspace owns dependency installation, shared tooling, and the Turborepo pipeline.
Each project keeps its own apps, docs, and conventions under its subtree.

## Contents

- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Files](#environment-files)
- [Local URLs](#local-urls)
- [Commands](#commands)
- [Projects](#projects)
- [Shared Tooling](#shared-tooling)
- [Testing and Quality Gates](#testing-and-quality-gates)
- [Operational Notes](#operational-notes)
- [Troubleshooting](#troubleshooting)
- [Further Reading](#further-reading)

## Architecture

Kagami is one git repository, one npm workspace install, and one Turborepo task graph. The
project subtrees were imported with `git subtree add`, so per-project history remains available
through `git log`.

```text
Kagami
|-- Kioku   memory API + dashboard
|-- Kokoro  Telegram/iMessage AI agent + dashboard
|-- Kizuna  CRM API + dashboard
`-- shared  workspace ESLint and TypeScript config packages
```

Runtime coupling is intentionally narrow:

```text
Kokoro -> Kioku   REST calls to KIOKU_URL for recall, fact writes, and session ingest
Kokoro -> Kizuna  REST calls to KIZUNA_URL for read-only CRM lookup tools
Kizuna -> Kioku   no outbound runtime dependency
Kizuna -> Kokoro  no outbound runtime dependency
Kioku  -> any     none; Kioku is pull-only by design
```

`dev-all.sh` starts Kioku first, waits briefly, then starts Kokoro and Kizuna in parallel. This
keeps Kokoro's first memory operations clean while still letting the services run as separate
processes.

For the full cross-service map, endpoint surfaces, env var details, auth notes, and future-edge
ideas, read [ARCHITECTURE.md](ARCHITECTURE.md).

## Repository Layout

```text
.
|-- ARCHITECTURE.md
|-- CLAUDE.md
|-- README.md
|-- dev-all.sh
|-- package.json
|-- package-lock.json
|-- turbo.json
|-- kioku/
|   |-- apps/
|   |   |-- api/
|   |   `-- dashboard/
|   |-- docs/
|   |-- CLAUDE.md
|   `-- portless.json
|-- kokoro/
|   |-- apps/
|   |   |-- bot/
|   |   `-- dashboard/
|   |-- packages/
|   |   |-- db/
|   |   |-- memory/
|   |   |-- shared/
|   |   `-- test-utils/
|   |-- scripts/
|   |-- docs/
|   |-- CLAUDE.md
|   `-- vitest.config.ts
|-- kizuna/
|   |-- apps/
|   |   |-- api/
|   |   `-- dashboard/
|   |-- docs/
|   |-- CLAUDE.md
|   `-- portless.json
`-- shared/
    `-- packages/
        |-- eslint-config/
        `-- tsconfig/
```

The project-level `CLAUDE.md` files are developer and agent guides. The project-level `docs/`
directories are the durable architecture references for internals.

## Prerequisites

- Node.js `>=22`
- npm matching the root package manager declaration, currently `npm@11.11.0`
- MongoDB access
  - Kioku needs Atlas Search/vector support for full retrieval behavior. Use Atlas Local or
    MongoDB Atlas, not vanilla MongoDB, when exercising `$vectorSearch` and `$search`.
  - Kokoro and Kizuna work with standard MongoDB for local development.
- Portless for named HTTPS `*.localhost` URLs. It is installed through workspace dependencies and
  invoked by app scripts.
- Optional external service accounts, depending on what you run:
  - Telegram bot token for Kokoro.
  - LLM provider keys or a local OpenAI-compatible endpoint.
  - Google OAuth credentials for Kokoro Gmail/Calendar tools.
  - Google OAuth credentials for Kizuna Gmail/Calendar ingest.
  - Brave Search, ElevenLabs, Browserbase, BlueBubbles, or Google Maps for optional Kokoro tools.

Portless may ask once for administrator privileges on first run so it can trust a local CA and bind
HTTPS on port 443.

## Quick Start

Install once from the root:

```bash
npm install
```

Create environment files from the templates you need:

```bash
cp kioku/apps/api/.env.example kioku/apps/api/.env
cp kioku/apps/dashboard/.env.example kioku/apps/dashboard/.env
cp kokoro/apps/bot/.env.example kokoro/apps/bot/.env
cp kizuna/apps/api/.env.example kizuna/apps/api/.env
cp kizuna/apps/dashboard/.env.example kizuna/apps/dashboard/.env
```

Start the full workspace:

```bash
npm run dev
```

`npm run dev` delegates to `./dev-all.sh`, which starts:

1. Kioku
2. Kokoro
3. Kizuna

Use `Ctrl-C` to stop all child processes.

For a narrower loop, start one project or component:

```bash
npm run kioku:dev
npm run kokoro:dev
npm run kizuna:dev

npm run kioku:dev:api
npm run kokoro:dev:bot
npm run kizuna:dev:dashboard
```

## Environment Files

Environment files are app-local and ignored by git. Keep secrets out of committed files.

| App              | Template                             | Runtime file                       | Notes                                               |
| ---------------- | ------------------------------------ | ---------------------------------- | --------------------------------------------------- |
| Kioku API        | `kioku/apps/api/.env.example`        | `kioku/apps/api/.env`              | Mongo, chat model, embedding model, provider keys   |
| Kioku dashboard  | `kioku/apps/dashboard/.env.example`  | `kioku/apps/dashboard/.env`        | `KIOKU_API_URL`                                     |
| Kokoro bot       | `kokoro/apps/bot/.env.example`       | `kokoro/apps/bot/.env`             | Telegram, Mongo, LLM, Kioku, Kizuna, optional tools |
| Kokoro dashboard | none currently                       | `kokoro/apps/dashboard/.env.local` | Optional `MONGODB_URI` and `DASHBOARD_PASSWORD`     |
| Kizuna API       | `kizuna/apps/api/.env.example`       | `kizuna/apps/api/.env`             | Mongo, Google OAuth, ingest scheduler               |
| Kizuna dashboard | `kizuna/apps/dashboard/.env.example` | `kizuna/apps/dashboard/.env`       | API URL, user emails                                |

### Kioku

Kioku API config lives in `kioku/apps/api/.env`.

Common local fields:

```bash
LLM_PROVIDER=lmstudio
MODEL=zai-org/glm-4.7-flash
EMBEDDING_PROVIDER=lmstudio
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
```

The default Mongo URI targets a local Atlas Search-capable instance. Start one with either:

```bash
atlas local start mongodb
```

or:

```bash
docker run -d -p 27017:27017 mongodb/mongodb-atlas-local
```

The dashboard reads `KIOKU_API_URL`, defaulting to `https://api.kioku.localhost`.

### Kokoro

Kokoro bot config lives in `kokoro/apps/bot/.env`.

Minimum useful local fields:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
ALLOWED_USER_IDS=123456789
MONGODB_URI=mongodb://localhost:27017/kokoro
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=your_anthropic_key_here
```

Kokoro reaches Kioku through `KIOKU_URL`, which defaults to
`https://api.kioku.localhost`. Use `http://localhost:7777` only when running Kioku standalone
outside Portless.

Kokoro reaches Kizuna through `KIZUNA_URL`, which defaults to
`https://api.kizuna.localhost`. The read-only CRM tools are enabled by default; set
`KIZUNA_ENABLED=false` in `kokoro/apps/bot/.env` to omit them from every tool palette.

For Google tools, set:

```bash
GOOGLE_OAUTH_CLIENT_ID=your_client_id_here
GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret_here
GOOGLE_OAUTH_REFRESH_TOKEN=your_refresh_token_here
```

To generate the refresh token from the root workspace:

```bash
npm run kokoro:auth:google
```

The Kokoro dashboard defaults to `mongodb://localhost:27017/kokoro`. Set
`DASHBOARD_PASSWORD` in `kokoro/apps/dashboard/.env.local` to enable basic auth in front of the
dashboard.

### Kizuna

Kizuna API config lives in `kizuna/apps/api/.env`.

Common local fields:

```bash
MONGO_URI=mongodb://127.0.0.1:27017/kizuna
USER_EMAILS=you@example.com
GOOGLE_OAUTH_REDIRECT_URI=https://api.kizuna.localhost/oauth/google/callback
KIZUNA_INGEST_INTERVAL_SEC=0
```

Generate the OAuth token encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then set:

```bash
KIZUNA_OAUTH_ENCRYPTION_KEY=generated_base64_value
```

The dashboard config points at the API and reuses `USER_EMAILS` for local-user classification:

```bash
KIZUNA_API_URL=https://api.kizuna.localhost
USER_EMAILS=you@example.com
```

Set `KIZUNA_INGEST_INTERVAL_SEC=300` for a five-minute Gmail/Calendar ingest loop during local
development. Keep it at `0` if you only want manual sync runs.

## Local URLs

HTTP apps run behind Portless. Prefer these URLs over numeric localhost ports.

| Project | Component | URL                                    |
| ------- | --------- | -------------------------------------- |
| Kioku   | Dashboard | `https://kioku.localhost`              |
| Kioku   | API       | `https://api.kioku.localhost`          |
| Kokoro  | Dashboard | `https://kokoro.localhost`             |
| Kokoro  | Bot       | No browser URL; it long-polls Telegram |
| Kizuna  | Dashboard | `https://kizuna.localhost`             |
| Kizuna  | API       | `https://api.kizuna.localhost`         |

Numeric fallback ports in app code are for standalone runs outside Portless. In normal local
development, Portless injects `PORT` and proxies the named HTTPS URL to the app process.

## Commands

All commands below are run from the Kagami root unless noted.

### Workspace

```bash
npm run dev
npm run build
npm run typecheck
npm run test
npm run lint
npm run lint:fix
npm run format
npm run format:check
```

Root scripts delegate to `turbo run <task>` for package tasks. Keep task implementation inside
package `package.json` files and keep the root scripts as orchestration aliases.

### Project Development

```bash
npm run kioku:dev
npm run kokoro:dev
npm run kizuna:dev
```

### Component Development

```bash
npm run kioku:dev:api
npm run kioku:dev:dashboard
npm run kokoro:dev:bot
npm run kokoro:dev:dashboard
npm run kizuna:dev:api
npm run kizuna:dev:dashboard
```

### Turborepo Filters

Use filters when you want one project or package:

```bash
npx turbo run typecheck --filter="@kioku/*"
npx turbo run lint --filter="@kokoro/*"
npx turbo run lint --filter="@kizuna/*"
npx turbo run build --filter="@kizuna/dashboard"
```

For changed packages and their dependents:

```bash
npx turbo run test --affected
```

### Project-Specific Commands

Kokoro has a workspace root Google OAuth helper:

```bash
npm run kokoro:auth:google
```

Kokoro's Vitest config lives at `kokoro/vitest.config.ts`:

```bash
cd kokoro
npx vitest run
```

Kizuna's API has watch tests and vCard import from the app directory:

```bash
cd kizuna/apps/api
npm run test:watch
npx tsx scripts/import-vcards.ts path/to/contacts.vcf
```

## Projects

### Kioku

Kioku is the long-term memory subsystem.

Primary responsibilities:

- Store atomic facts from transcripts.
- Retrieve memories with hybrid vector, BM25, and entity scoring.
- Answer questions using retrieved facts.
- Expose REST endpoints and an MCP transport.
- Provide a Next.js dashboard for inspection.

Layout:

```text
kioku/apps/api        Express API, MCP transport, ingest, retrieval, storage
kioku/apps/dashboard  Next.js inspector dashboard
kioku/docs            Architecture, API, storage, retrieval, ingest, testing, configuration
```

Important runtime notes:

- API runs at `https://api.kioku.localhost` in normal dev.
- Dashboard runs at `https://kioku.localhost`.
- Dashboard calls the API through `KIOKU_API_URL`.
- MongoDB should support Atlas Search and vector indexes for the full retrieval path.
- Kioku has no runtime dependency on Kokoro or Kizuna.

Key docs:

- [kioku/docs/architecture.md](kioku/docs/architecture.md)
- [kioku/docs/api.md](kioku/docs/api.md)
- [kioku/docs/configuration.md](kioku/docs/configuration.md)
- [kioku/docs/retrieval.md](kioku/docs/retrieval.md)
- [kioku/docs/storage.md](kioku/docs/storage.md)

### Kokoro

Kokoro is the conversational AI agent.

Primary responsibilities:

- Receive and respond to Telegram messages.
- Optionally integrate with iMessage through BlueBubbles.
- Assemble personality and context from `kokoro/apps/bot/context/`.
- Call LLM tools for memory, email, calendar, routines, watchers, web search, browser automation,
  media, confirmations, voice, and location.
- Persist conversation state, routines, watchers, confirmations, token usage, reminders, and images.
- Delegate long-term memory to Kioku.

Layout:

```text
kokoro/apps/bot          Grammy bot, AI layer, platform adapters, schedulers
kokoro/apps/dashboard    Next.js dashboard for routines, watchers, conversations, usage
kokoro/packages/shared   Config, logger, markdown, shared types
kokoro/packages/db       Mongoose models and GridFS helpers
kokoro/packages/memory   Kioku client, transcript glue, session ingest, sweeper
kokoro/packages/test-utils
kokoro/docs
```

Important runtime notes:

- Bot long-polls Telegram and does not expose a browser URL.
- Dashboard runs at `https://kokoro.localhost`.
- `KIOKU_URL` defaults to `https://api.kioku.localhost`.
- Kioku failures are handled fail-open so chat can continue in degraded mode.
- `ALLOWED_USER_IDS` gates Telegram users for a single-user deployment.
- Optional Google tools require all `GOOGLE_OAUTH_*` fields together.

Key docs:

- [kokoro/docs/architecture.md](kokoro/docs/architecture.md)
- [kokoro/docs/ai-layer.md](kokoro/docs/ai-layer.md)
- [kokoro/docs/memory.md](kokoro/docs/memory.md)
- [kokoro/docs/testing.md](kokoro/docs/testing.md)
- [kokoro/docs/google-services.md](kokoro/docs/google-services.md)
- [kokoro/docs/imessage.md](kokoro/docs/imessage.md)

### Kizuna

Kizuna is the personal CRM.

Primary responsibilities:

- Track people, organizations, interactions, and follow-ups.
- Provide REST endpoints for concierge-style writes and dashboard reads.
- Ingest Gmail and Google Calendar data into the relationship graph.
- Encrypt Google OAuth refresh tokens at rest.
- Provide a Next.js dashboard for people, contexts, sync status, tombstones, and errors.

Layout:

```text
kizuna/apps/api        Express API, Mongoose models, Gmail/Calendar ingest, OAuth
kizuna/apps/dashboard  Next.js App Router dashboard
kizuna/docs            API, auth, configuration, data model, sync, dashboard, testing
```

Important runtime notes:

- API runs at `https://api.kizuna.localhost`.
- Dashboard runs at `https://kizuna.localhost`.
- `/v1/*` routes are open at single-user localhost; there is no bearer token on local API calls.
- The dashboard sends no API auth header and has no login layer.
- `USER_EMAILS` identifies the local user's addresses for ingest and dashboard classification.
- `KIZUNA_OAUTH_ENCRYPTION_KEY` must decode to exactly 32 bytes.
- Kizuna has no outbound runtime dependency on Kioku or Kokoro; Kokoro can consume Kizuna's
  read-only CRM API.

Key docs:

- [kizuna/docs/architecture.md](kizuna/docs/architecture.md)
- [kizuna/docs/api.md](kizuna/docs/api.md)
- [kizuna/docs/auth.md](kizuna/docs/auth.md)
- [kizuna/docs/configuration.md](kizuna/docs/configuration.md)
- [kizuna/docs/data-model.md](kizuna/docs/data-model.md)
- [kizuna/docs/sync.md](kizuna/docs/sync.md)

## Shared Tooling

Shared workspace packages live under `shared/packages/`.

| Package                 | Exports                                                           | Purpose                                        |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| `@kagami/eslint-config` | `./base`, `./next`                                                | Flat ESLint presets for TypeScript and Next.js |
| `@kagami/tsconfig`      | `./base.json`, `./library.json`, `./server.json`, `./nextjs.json` | Shared TypeScript bases                        |

Conventions across projects:

- TypeScript, strict mode, ESM.
- Zod validation at request and config boundaries.
- Pino structured logging.
- Next.js dashboards for inspection and operations.
- MongoDB for persistent state.
- Portless for stable HTTPS local URLs.
- App and package scripts live in package manifests; root scripts delegate through Turbo.

Kokoro has internal packages for shared config, persistence, memory, the Kizuna client, and tests.
Kioku and Kizuna currently keep project-specific reusable logic inside their apps, with empty or
reserved package slots for future libraries.

## Testing and Quality Gates

Before opening a change across the workspace, run the smallest useful checks first, then broaden
when the change crosses package boundaries.

Common checks:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run format:check
```

Filtered checks:

```bash
npx turbo run typecheck --filter="@kokoro/*"
npx turbo run test --filter="@kioku/api"
npx turbo run lint --filter="@kizuna/*"
```

Project-specific test notes:

- Kioku API uses Node's built-in test runner with `mongodb-memory-server`.
- Kokoro has a workspace Vitest config under `kokoro/vitest.config.ts`.
- Kizuna API uses Vitest, Supertest, and Testcontainers with real MongoDB containers.
- Dashboard tests are currently lighter than API tests; rely on typecheck, lint, and build when
  changing UI code.

Project docs treat tests as a source of truth. If production behavior and tests disagree, inspect
the implementation contract before weakening assertions.

## Operational Notes

- This is a single-user-oriented workspace. Do not expose local dashboards or APIs publicly without
  putting production-grade auth and network controls in front of them.
- Secrets live in app-local `.env` files and are ignored by git.
- `ARCHITECTURE.md` is the source of truth for cross-service coupling. Update it when a service
  starts calling another service, changes auth shape, or changes local URL assumptions.
- Project docs under `<project>/docs/` are the source of truth for project internals.
- Keep producer and consumer contract changes together when possible. For example, if Kioku changes
  a REST response used by Kokoro, update both sides and the relevant docs in the same branch.
- Prefer Turbo filters over changing directories for normal workspace tasks. Use app directories for
  truly app-local commands such as watch tests or import scripts.

## Troubleshooting

### Portless asks for a password

The first run may need administrator approval to install and trust the local CA and bind HTTPS on
port 443. After that, `https://*.localhost` URLs should work without repeated prompts.

### A `*.localhost` URL does not resolve

Make sure the relevant dev process is running. Use the project script for the app you need:

```bash
npm run kioku:dev
npm run kokoro:dev:dashboard
npm run kizuna:dev:api
```

Prefer the named HTTPS URLs over numeric ports unless you intentionally started an app outside
Portless.

### Kioku search or vector retrieval fails

Use Atlas Local or MongoDB Atlas for Kioku. Vanilla MongoDB does not support the `$vectorSearch` and
`$search` paths Kioku uses for full retrieval.

### Kizuna dashboard cannot log in or fetch data

Check that `KIZUNA_API_URL` points at `https://api.kizuna.localhost` and that the API is running.
There is no Kizuna dashboard login or API key in local development.

### Kokoro starts but memory is unavailable

Confirm Kioku is running at `https://api.kioku.localhost`, or override `KIOKU_URL` in
`kokoro/apps/bot/.env`. Kokoro is designed to fail open and retry memory ingest later, so a memory
outage does not necessarily stop chat.

### Google OAuth fails

For Kokoro, make sure all three `GOOGLE_OAUTH_*` fields are present together in
`kokoro/apps/bot/.env`.

For Kizuna, make sure the Google Cloud OAuth redirect URI exactly matches:

```text
https://api.kizuna.localhost/oauth/google/callback
```

Also confirm `KIZUNA_OAUTH_ENCRYPTION_KEY` is a base64-encoded 32-byte value.

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md): cross-service architecture and URL/env cheat sheet
- [CLAUDE.md](CLAUDE.md): workspace-level developer and agent guide
- [kioku/CLAUDE.md](kioku/CLAUDE.md): Kioku developer guide
- [kokoro/CLAUDE.md](kokoro/CLAUDE.md): Kokoro developer guide
- [kizuna/CLAUDE.md](kizuna/CLAUDE.md): Kizuna developer guide
- [kioku/docs](kioku/docs): Kioku internals
- [kokoro/docs](kokoro/docs): Kokoro internals
- [kizuna/docs](kizuna/docs): Kizuna internals
