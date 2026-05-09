# CLAUDE.md

## Project

Kizuna — a personal CRM that tracks people, organizations, interactions, and follow-ups. Auto-ingests Gmail and Google Calendar to populate the relationship graph; everything else is concierge-driven via REST. Built with TypeScript, Express 5, Mongoose, and a Next.js 15 dashboard. Lives as a subtree inside the Kagami nested monorepo and consumes shared tooling via `@kagami/eslint-config` and `@kagami/tsconfig` from `shared/packages/`. Kokoro consumes the API for read-only CRM tools; Kizuna itself has no outbound runtime coupling to Kioku or Kokoro.

## Monorepo Structure

```
kizuna/
├── apps/
│   ├── api/                # Express HTTP API (entry: src/main.ts)
│   │   ├── src/
│   │   │   ├── main.ts         # boot: loadConfig → connectDb → createApp → ingestScheduler
│   │   │   ├── server.ts       # Express app builder + middleware mount order
│   │   │   ├── config.ts       # zod env schema; thrown errors on misconfig
│   │   │   ├── db/             # Mongoose connect + models + recordInteraction writer
│   │   │   ├── ingest/         # Gmail + Calendar workers, parsers, scheduler
│   │   │   ├── routes/         # per-resource Express routers
│   │   │   ├── lib/            # errors, encryption, oauth-state, google-auth, cursor, duration, serialize, logger
│   │   │   └── schemas/        # shared zod (Pagination, IdParam, ISODateString, …)
│   │   ├── tests/          # vitest + supertest + mongodb-memory-server (real Mongo, no Docker)
│   │   └── scripts/        # import-vcards.ts (vCard → POST /people)
│   └── dashboard/          # Next.js 15 App Router (https://kizuna.localhost)
│       ├── app/
│       │   └── (app)/      # all routes — Today, People, Contexts, Sync, Errors, Tombstones (no login)
│       ├── components/     # sidebar, nav-link, shell/, ui/ (shadcn-shaped)
│       └── lib/            # api client, types, format
├── packages/               # reserved for future Kizuna-only libs (currently empty)
├── portless.json           # api.kizuna + kizuna Portless registrations
└── docs/
```

**Stack**: Kizuna is a subtree inside the Kagami nested monorepo (npm workspaces + Turborepo, orchestrated from the Kagami root). It has no project-internal TypeScript packages today; the apps consume only the shared config packages `@kagami/eslint-config` and `@kagami/tsconfig` from Kagami's `shared/packages/`. The two apps share **no in-process code** — they communicate only over HTTP.

## Commands

All commands run from the Kagami workspace root (Kizuna no longer has a top-level `package.json`).

```bash
# From the Kagami workspace root:
npm run kizuna:dev              # both Kizuna apps under Portless (https://kizuna.localhost + https://api.kizuna.localhost)
npm run kizuna:dev:api          # API only
npm run kizuna:dev:dashboard    # Dashboard only
./dev-all.sh                    # Kioku → Kokoro + Kizuna together with prefixed output

npm run typecheck               # all workspaces (tsc --noEmit)
npm run test                    # all workspaces
npm run lint                    # all workspaces
# Filter to Kizuna only:
npx turbo run typecheck --filter="@kizuna/*"
npx turbo run test     --filter="@kizuna/*"
npx turbo run lint     --filter="@kizuna/*"
```

Both apps run under [Portless](https://github.com/vercel-labs/portless): API at `https://api.kizuna.localhost`, dashboard at `https://kizuna.localhost`. Each `dev` script wraps the framework launcher with `portless run …`. Standalone fallback ports only matter when running an app directly outside Portless; normal local development should use the named HTTPS URLs.

App-level scripts still work when run from inside the app directory (vitest auto-discovers the project-root `kizuna/vitest.config.ts` by walking up):

```bash
cd kizuna/apps/api
npm run test:watch      # vitest watch
npm run lint:fix
npx tsx scripts/import-vcards.ts <path-to.vcf>   # bulk-create people from vCard
```

## Dependency Graph

```
@kagami/eslint-config  ← shared (lives in Kagami's shared/packages/)
@kagami/tsconfig       ← shared (lives in Kagami's shared/packages/)
       ↑
@kizuna/api          ← Express, Mongoose, Gmail/Calendar ingest
@kizuna/dashboard    ← Next.js 15 (talks to API over HTTP via KIZUNA_API_URL)
```

The two apps share **no in-process code**. The dashboard's contract with the API is the REST surface in `apps/api/src/routes/*` plus the OAuth handlers, hit through `fetch` to `KIZUNA_API_URL` (default `https://api.kizuna.localhost`). The dashboard mirrors the API's serialized shapes by hand in `apps/dashboard/src/lib/types.ts` — keep that file in sync with `apps/api/src/lib/serialize.ts` when shapes change.

## Conventions

- **TypeScript + ESM** — strict mode, ES2023 target, NodeNext for the API; bundler resolution + `module: ESNext` for the dashboard. The API extends `@kagami/tsconfig/server.json` and adds `verbatimModuleSyntax: true`, `noImplicitOverride: true`, `esModuleInterop: true` as overrides. The dashboard extends `@kagami/tsconfig/nextjs.json` and overrides `verbatimModuleSyntax: false` plus `allowJs: true`.
- **Async everywhere** — all I/O is async/await, no callbacks.
- **Zod at boundaries** — every request body / query / params parsed by zod in the route handler; the global error handler maps `ZodError` to `400 { error: { code: "bad_request", message: "invalid input", details } }`. Internal modules trust their inputs.
- **Pino logging** — singleton in `apps/api/src/lib/logger.ts`, `pino-pretty` in `NODE_ENV=development`. `logger.info({ context }, "message")` pattern. There is no `pino-http` middleware today; route logging is request-scoped only via thrown errors hitting `makeErrorHandler`.
- **No classes for services** — routers, ingest workers, parsers are all standalone exported functions. The only classes are `HttpError`, `OAuthError`, `GmailHttpError`, `CalendarHttpError`, and `SyncTokenExpired` — all error envelopes.
- **Mongoose `strict: 'throw'` everywhere** — every model uses `baseSchemaOptions = { timestamps: true, strict: 'throw', versionKey: false }`. Unknown fields on write reject the insert, which the error handler turns into a `400 bad_request`. Combined with zod-strict request bodies, this is two layers of contract enforcement.
- **Provenance fields on every doc** — every model spreads `provenanceFields = { source, sourceVersion?, deletedAt: null }` from `db/models/base.ts`. `source` is one of `'concierge' | 'gmail-sync' | 'gcal-sync' | 'manual' | 'import'`.
- **Soft delete via `deletedAt`** — DELETE handlers never remove rows; they `findOneAndUpdate` with `{ deletedAt: new Date() }`. List endpoints filter `deletedAt: null` unless `?includeTombstoned=true`. Person tombstones additionally set `suppressReingest: true` so the upsert path won't recreate them.
- **AES-256-GCM for OAuth tokens** — Google refresh tokens are encrypted at rest with `KIZUNA_OAUTH_ENCRYPTION_KEY` (a base64 32-byte key). See `apps/api/src/lib/encryption.ts`. The IV is random per write, the auth tag is appended, and the envelope is `base64(iv ‖ tag ‖ ciphertext)`.
- **No API auth at single-user localhost** — resource routes are open; the OS user is the trust boundary. The OAuth callback is still CSRF-protected by an HMAC-signed state token whose secret is process-local (`randomBytes(32)` at module load in `apps/api/src/lib/oauth-state.ts`). See [docs/auth.md](docs/auth.md) for the threat model.
- **Cross-package imports** — `@kagami/eslint-config`, `@kagami/tsconfig` only (no project-internal packages today). The API's `eslint.config.js` imports from `@kagami/eslint-config/base`; the dashboard's `eslint.config.mjs` imports from `@kagami/eslint-config/next`.
- **Within-package imports (API)** — relative paths with explicit `.js` extensions (NodeNext requirement).
- **Within-package imports (dashboard)** — `@/*` path aliases (e.g. `@/lib/api`, `@/components/ui/button`); no extensions.
- **`.env` location** — `apps/api/.env` and `apps/dashboard/.env`. `apps/api/.env.example` and `apps/dashboard/.env.example` are templates.
- **Tests as source of truth** — when a test fails because production behaves differently than the test expects, fix the API, not the test. See [docs/testing.md](docs/testing.md).
- **Internal packages pattern** — Kizuna has no project-internal TypeScript packages today; the apps consume only the shared `@kagami/*` config packages from Kagami's `shared/packages/`. The local `kizuna/packages/` directory is reserved for future Kizuna-only libs.

## Doc Maintenance

After any code change, update the relevant doc in `/docs` to reflect the change. If a new module or major feature is added, create a new doc file. Keep docs accurate — they are the primary architecture reference.

See `/docs` for:

- [architecture.md](docs/architecture.md) — system overview, request flow, dependency graph, boot sequence, design decisions
- [api.md](docs/api.md) — REST surface, OAuth, auth model, error envelope, request/response shapes
- [data-model.md](docs/data-model.md) — Mongoose models (Person, Interaction, Followup, Organization, OAuthToken, SyncState), indexes, the `recordInteraction` writer
- [sync.md](docs/sync.md) — Gmail + Calendar ingest pipeline (state machines, cursors, dedup via `sourceRef`, scheduler)
- [auth.md](docs/auth.md) — single-user-localhost trust model, USER_EMAILS allowlist, AES-256-GCM refresh-token encryption, signed CSRF state on the OAuth callback, threat model
- [dashboard.md](docs/dashboard.md) — Next.js inspector pages, design system ("Mashiro Daylight"), data flow
- [configuration.md](docs/configuration.md) — env vars, encryption-key generation, common setups, Portless
- [testing.md](docs/testing.md) — vitest + supertest + mongodb-memory-server harness, what's covered, patterns
