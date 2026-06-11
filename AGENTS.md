# AGENTS.md

## Project

Kagami ("mirror") is a personal-AI workspace. It contains five sibling TypeScript domain projects in one nested monorepo: **Kioku** (記憶, memory), **Kizuna** (絆, bond/relationship), **Kokoro** (心, heart/mind), **Kansoku** (観測, observation), and **Kao** (顔, face/identity), plus **Cockpit**, a thin workspace-level operator dashboard. They share tooling, a single `package.json` install, and a unified Turborepo pipeline, but each project is bounded — its apps, internal packages, docs, and guide file live under its own subdirectory.

> **Kao status:** **Identity consolidation complete.** Both Kokoro and Kizuna read short-lived Google access tokens from Kao at runtime — no service in the workspace holds its own Google refresh token anymore. Kioku has no Google OAuth and never did.

This file is the workspace-level Codex guide. Domain projects currently keep their deeper guide in `CLAUDE.md`; Cockpit uses `AGENTS.md`. Start here for cross-cutting context, then descend.

## Workspace Structure

```
Kagami/                       # one git repo, one workspace
├── ARCHITECTURE.md           # full cross-service map (auth, endpoints, env vars, coupling notes)
├── AGENTS.md                 # this file
├── package.json              # workspace root: workspace globs + shared devDeps
├── turbo.json                # unified pipeline (build, dev, typecheck, test, lint)
├── dev-all.sh                # boot all domain services + Cockpit under Turbo's TUI (or streamed)
│
├── kioku/                    # long-term memory store
│   ├── apps/                 # api, dashboard
│   ├── docs/
│   ├── CLAUDE.md
│   ├── portless.json
│   └── vitest.config.ts
│
├── kokoro/                   # Telegram + iMessage AI agent
│   ├── apps/                 # bot, dashboard
│   ├── packages/             # shared, db, memory, kizuna, test-utils
│   ├── scripts/              # auth scripts
│   ├── docs/
│   ├── CLAUDE.md
│   └── vitest.config.ts
│
├── kizuna/                   # personal CRM
│   ├── apps/                 # api, dashboard
│   ├── docs/
│   ├── CLAUDE.md
│   ├── portless.json
│   └── vitest.config.ts
│
├── kansoku/                  # observability service (logs, traces, errors, metrics)
│   ├── apps/                 # api, dashboard
│   ├── docs/
│   ├── CLAUDE.md
│   ├── portless.json
│   └── vitest.config.ts
│
├── kao/                      # identity service — per-consumer Google OAuth grants
│   ├── apps/                 # api, dashboard (Next.js operator UI; bearer-injected server-side)
│   ├── docs/
│   ├── CLAUDE.md
│   ├── portless.json
│   └── vitest.config.ts
│
├── cockpit/                  # workspace operator cockpit (read-only)
│   ├── apps/                 # dashboard
│   ├── docs/
│   ├── AGENTS.md
│   └── portless.json
│
└── shared/
    └── packages/
        ├── eslint-config/    # @kagami/eslint-config (./base, ./next)
        ├── llm/              # @kagami/llm (createInference: provider/key mgmt, retry, same-tier fallback, reasoning-repair, span+usage seam)
        ├── logger/           # @kagami/logger (createLogger factory, ECS field names, trace/span helpers, Kansoku shipper)
        └── tsconfig/         # @kagami/tsconfig (./base.json, ./library.json, ./server.json, ./nextjs.json, ./server.build.json, ./library.build.json)
```

The Kagami root is the single git repo. The Kioku, Kokoro, and Kizuna subtrees were imported via `git subtree add` so each project's prior history is preserved in `git log`; Kansoku (observability), Kao (identity), and Cockpit were added natively. Each project still has its own guide file and `docs/` next to its code.

## How they relate

```
Kokoro ──HTTP──► Kioku            Kokoro reads/writes facts via REST.
                                  KIOKU_URL defaults to https://api.kioku.localhost.
Kokoro ──HTTP──► Kizuna           Kokoro reads CRM context directly; writes
                                  (logInteraction/createFollowup/resolveFollowup/
                                  updatePerson) are confirmation-gated.
                                  KIZUNA_URL defaults to https://api.kizuna.localhost.
Kizuna ────X──── Kioku/Kokoro     No outbound code references to sibling services.
Kioku  ────X──── anything         Pull-only by design; never initiates outbound to siblings.
{Kioku,Kokoro,Kizuna,Kao} ──HTTP──► Kansoku
                                  Observability push from @kagami/logger transport,
                                  fail-open. KANSOKU_URL defaults to
                                  https://api.kansoku.localhost. Live ingest, live
                                  tail (SSE), historical search, distributed
                                  tracing, fingerprinted errors, derived metrics,
                                  optional new-error webhook — see
                                  kansoku/docs/architecture.md.
Kansoku ────X──── anything        Push-only-in. Never initiates outbound to siblings.
Kokoro ──HTTP──► Kao              LIVE. Fetches a fresh Google access token
                                  from /grants/kokoro/token (bearer KAO_TOKEN)
                                  instead of owning a refresh token. Plaintext
                                  GOOGLE_OAUTH_REFRESH_TOKEN is gone.
Kizuna ──HTTP──► Kao              LIVE. Fetches a fresh Google access token
                                  from /grants/kizuna/token (bearer KAO_TOKEN)
                                  instead of owning an AES-encrypted refresh
                                  token in its own Mongo. The legacy
                                  encryption.ts / oauth-state.ts / OAuthToken
                                  model are gone.
                                  Kioku has no Google OAuth, ever.
Kao    ────X──── anything         Vend-only-in. Outbound only to Google
                                  (token exchange/refresh/revoke).
```

`dev-all.sh` boots all domain services plus Cockpit in parallel — there is no startup ordering between them. Kokoro's Kioku client is fail-open (`KiokuClientError` is caught at the AI tool layer; chat continues degraded), and any pending writes are retried by Kokoro's 5-min sweeper. Kokoro's Kizuna CRM read tools are also fail-open at the tool layer; write tools (`logInteraction`, `createFollowup`, `resolveFollowup`, `updatePerson`) only fire from Kokoro's gated dispatcher after the user taps Approve. Each configured Kansoku shipper is fail-open at the call site — observability failure must never wedge a producer service. Cockpit is read-only and fail-open per source: one unavailable service produces a down card, not a broken page.

See `ARCHITECTURE.md` for the full edge table, endpoint surface, and per-project env-var cheat sheet.

## Commands

All commands run from the Kagami root.

```bash
./dev-all.sh                     # boot all services + Cockpit under Turbo's TUI
                                 # (per-task panes, single Ctrl-C stops all)
./dev-all.sh --no kokoro:bot     # selective: --only / --no take projects or
./dev-all.sh --only kioku        # components (e.g. kokoro:bot, kioku:dashboard,
./dev-all.sh --stream            #            kansoku:api). --stream forces
                                 #            streamed [prefix] output.
npm run dev                      # alias for ./dev-all.sh
npm run typecheck                # turbo run typecheck across every workspace
npm run test                     # turbo run test
npm run lint                     # turbo run lint
npm run lint:fix
npm run build                    # turbo run build
npm run format                   # prettier --write all files

# Per-project filters
npm run kioku:dev                # turbo run dev --filter="@kioku/*"
npm run kokoro:dev
npm run kizuna:dev
npm run kansoku:dev
npm run kao:dev
npm run cockpit:dev

# Per-component filters
npm run kioku:dev:api
npm run kioku:dev:dashboard
npm run kokoro:dev:bot
npm run kokoro:dev:dashboard
npm run kizuna:dev:api
npm run kizuna:dev:dashboard
npm run kansoku:dev:api
npm run kansoku:dev:dashboard
npm run kao:dev:api
npm run kao:dev:dashboard
npm run cockpit:dev:dashboard

# Project-specific scripts
npm run kansoku:debug -- <subcommand>   # read-only Kansoku CLI for agents
                                        # (trace | logs | errors | services)
```

`npm install` is hoisted at the Kagami root. There is no per-project `package.json` and no per-project `node_modules` install step.

## Local hosting via Portless

All HTTP entry points are served as HTTPS named URLs by [Portless](https://github.com/vercel-labs/portless) (Vercel Labs reverse proxy). First run prompts once for sudo to install a local CA; HTTPS is auto-trusted thereafter. Portless picks an ephemeral port per app and binds 443.

| Project | Component | URL                             |
| ------- | --------- | ------------------------------- |
| Kioku   | dashboard | `https://kioku.localhost`       |
| Kioku   | API       | `https://api.kioku.localhost`   |
| Kokoro  | dashboard | `https://kokoro.localhost`      |
| Kokoro  | bot       | (none — Telegram long-poll)     |
| Kizuna  | dashboard | `https://kizuna.localhost`      |
| Kizuna  | API       | `https://api.kizuna.localhost`  |
| Kansoku | dashboard | `https://kansoku.localhost`     |
| Kansoku | API       | `https://api.kansoku.localhost` |
| Kao     | dashboard | `https://kao.localhost`         |
| Kao     | API       | `https://api.kao.localhost`     |
| Cockpit | dashboard | `https://kagami.localhost`      |

Each project keeps its own `portless.json` next to its code. Numeric `PORT` defaults inside apps only matter when running an app standalone outside Portless; normal local development should use the named HTTPS URLs above.

## Shared conventions

All five projects share tooling via `shared/packages/`:

- **`@kagami/eslint-config`** — flat ESLint config; `./base` for general TS, `./next` for Next.js apps.
- **`@kagami/tsconfig`** — `./base.json`, `./library.json`, `./server.json`, `./nextjs.json`, plus emit-on build presets `./server.build.json` and `./library.build.json` (consumed by each compiled package's `tsconfig.build.json`). Per-app `tsconfig.json` files extend one of these and add overrides (e.g. `verbatimModuleSyntax`, `esModuleInterop`, `noImplicitOverride`, `allowImportingTsExtensions`, `allowJs`) where projects diverge.
- **`@kagami/llm`** — inference gateway exposing `createInference({ service, logger, chat, embedding?, fallback?, models? })`. Owns provider construction (native `@ai-sdk/{anthropic,openai,xai,google}` + `@ai-sdk/openai-compatible`), key management, full-jitter retry, same-tier fallback, per-attempt timeout, the LM-Studio `reasoning_content` repair (default-on for `openai-compatible`), the Anthropic system-message hoist (trailing system messages are folded into the leading block instead of failing the call), and span+usage emission via an internal observability seam. Returns AI SDK model objects — callers keep `generateText`/`generateObject`/`embed`; the gateway owns construction, not invocation. Tier _policy_ stays caller-side. Consumed by Kioku (`apps/api/src/llm.ts`) and Kokoro (`apps/bot/src/ai/provider.ts`). Like `@kagami/logger`, it is a **built** package — it emits `dist/` JS + `.d.ts` and its `exports` map to `dist`, so compiled services consume it without a TypeScript runtime; Turbo's `dev`/`typecheck`/`test` depend on `^build` so it is compiled before consumers resolve it.
- **`@kagami/logger`** — Pino factory exposing `createLogger({ service, component, env, level?, formatters?, kansoku? })`. Emits ECS / OTel field names (`log.level`, `@timestamp`, `service.*`, `trace.id`, `error.*`, …); owns the console transport policy (`pino-pretty` only on an interactive TTY or `LOG_PRETTY=1`, raw NDJSON otherwise) and the Kansoku shipper (write-then-ack aware, full-jitter backoff). Also exports trace helpers including `runWithSpan` (build-light spans → `event.kind:"span"` lines). No secret/PII redaction (local-trust only — reintroduce before non-localhost exposure). Each service's `logger.ts` is a thin wrapper that calls it with service-specific bindings. Like `@kagami/llm`, and unlike the `@kokoro/*` internal packages (raw `.ts`), `@kagami/logger` is a **built** package — it emits `dist/` JS + `.d.ts` and its `exports` map to `dist`, so the Express APIs run from compiled output in production (`build` → `start` = `node dist/...`); Turbo's `dev`/`typecheck`/`test` depend on `^build` so it is compiled before consumers resolve it.

Other workspace-wide conventions:

- **Language**: TypeScript (strict, ESM), Node ≥ 22
- **Package layout**: nested monorepo via npm workspaces + Turborepo. Workspace globs are `kioku/{apps,packages}/*`, `kokoro/{apps,packages}/*`, `kizuna/{apps,packages}/*`, `kansoku/{apps,packages}/*`, `kao/{apps,packages}/*`, `cockpit/{apps,packages}/*`, and `shared/packages/*`.
- **Apps split**: `apps/api` (or `apps/bot` for Kokoro) + `apps/dashboard` (Kao's dashboard injects its `KAO_TOKEN` bearer server-side; the API also still serves an inline-HTML operator page at `GET /` as a no-dashboard fallback)
- **Local dev hosting**: Portless via stable HTTPS named `*.localhost` URLs
- **Database**: MongoDB (Mongoose in Kizuna and Kokoro; raw driver in Kioku and Kao)
- **Logging**: Pino (structured) via `@kagami/logger` — ECS / OTel field names, stable service bindings, trace/span correlation; no redaction (local-trust only)
- **Validation**: Zod schemas at boundaries
- **Formatting**: Prettier; ESLint flat config

### Husky + lint-staged

Live at the workspace root. The `prepare` script runs `husky` after install; the `.husky/pre-commit` hook runs `npx lint-staged` on staged files. Each project's prior `.husky/` was removed during migration.

Lint-staged globs:

- `**/apps/**/src/**/*.{ts,tsx}` and `**/packages/**/*.ts` — `eslint --fix` + `prettier --write` (per-project ESLint configs cover these paths)
- `**/apps/**/{tests,scripts}/**/*.{ts,tsx}` and `**/scripts/**/*.ts` — `prettier --write` only (ESLint coverage of these paths varies per project, so they're prettier-only to avoid surfacing lint regressions on previously-uncovered code)
- `**/*.{json,md}` — `prettier --write`

## Per-project entry points

When working inside a project, consult that project's guide file first — it's authoritative for module structure, conventions, and the docs index.

| Project | Role                                        | Start here                               |
| ------- | ------------------------------------------- | ---------------------------------------- |
| Kioku   | Long-term memory service                    | [`kioku/CLAUDE.md`](kioku/CLAUDE.md)     |
| Kokoro  | Telegram + iMessage AI agent                | [`kokoro/CLAUDE.md`](kokoro/CLAUDE.md)   |
| Kizuna  | Personal CRM                                | [`kizuna/CLAUDE.md`](kizuna/CLAUDE.md)   |
| Kansoku | Observability (logs, traces, errors, etc.)  | [`kansoku/CLAUDE.md`](kansoku/CLAUDE.md) |
| Kao     | Identity — per-consumer Google OAuth grants | [`kao/CLAUDE.md`](kao/CLAUDE.md)         |
| Cockpit | Workspace operator dashboard                | [`cockpit/AGENTS.md`](cockpit/AGENTS.md) |

For cross-service detail (Kokoro→Kioku coupling, observed gaps, and the completed Kao identity consolidation), see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Working in this workspace

- **One repo, one PR flow.** Cross-service edits (e.g. changing the Kokoro→Kioku contract) can be a single commit/PR now. Producers should still ship before consumers in the same commit, and tests should cover both sides.
- **`ARCHITECTURE.md` is the source of truth for cross-service facts.** Update it when an edge is added, removed, or its shape changes (URLs, env vars, auth model, coupling direction).
- **Per-project docs (`<project>/docs/`) are the source of truth for that project's internals.** Update them when modules, schemas, endpoints, or conventions change.
- **Adding a new service**: create `<name>/` at the top level with its own `apps/`, `packages/`, `docs/`, guide file, `portless.json`, `vitest.config.ts`; add `<name>/{apps,packages}/*` to the root `package.json` workspaces; wire `<name>:dev` scripts and the `dev-all.sh` dispatch blocks. **Kao** (identity / OAuth) is the worked example of this — see `kao/CLAUDE.md`.
