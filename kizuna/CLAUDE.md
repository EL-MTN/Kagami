# CLAUDE.md

## Project

Kizuna — a personal CRM that tracks people, organizations, interactions, and follow-ups. Auto-ingests Gmail and Google Calendar to populate the relationship graph; everything else is concierge-driven via REST. Built as a monorepo with TypeScript, Express 5, Mongoose, and a Next.js 15 dashboard. Standalone within the Kagami workspace — no runtime coupling to Kioku or Kokoro.

## Monorepo Structure

```
kizuna/
├── apps/
│   ├── api/                # Express HTTP API (entry: src/main.ts)
│   │   ├── src/
│   │   │   ├── main.ts         # boot: loadConfig → connectDb → createApp → ingestScheduler
│   │   │   ├── server.ts       # Express app builder + middleware mount order
│   │   │   ├── config.ts       # zod env schema; thrown errors on misconfig
│   │   │   ├── manifest.ts     # zod-to-json-schema → /v1/_manifest
│   │   │   ├── db/             # Mongoose connect + models + recordInteraction writer
│   │   │   ├── ingest/         # Gmail + Calendar workers, parsers, scheduler
│   │   │   ├── routes/         # per-resource Express routers
│   │   │   ├── lib/            # auth, errors, encryption, oauth-state, google-auth, cursor, duration, serialize, logger
│   │   │   └── schemas/        # shared zod (Pagination, IdParam, ISODateString, …)
│   │   ├── test/           # vitest + supertest + testcontainers (real Mongo)
│   │   └── scripts/        # import-vcards.ts (vCard → POST /v1/people)
│   └── dashboard/          # Next.js 15 App Router (https://kizuna.localhost)
│       ├── app/
│       │   ├── (app)/      # authed routes — Today, People, Contexts, Sync, Errors, Tombstones
│       │   └── (auth)/     # /login (API-key sign-in)
│       ├── components/     # sidebar, nav-link, shell/, ui/ (shadcn-shaped)
│       └── lib/            # api client, types, session (HMAC cookie), format
├── packages/
│   ├── typescript-config/  # JSON tsconfig bases (base.json + nextjs.json)
│   └── eslint-config/      # shared flat ESLint config (base + next)
├── portless.json           # api.kizuna + kizuna Portless registrations
└── docs/
```

**Stack**: npm workspaces + Turborepo. The two `packages/*` are config-only (JSON / a single flat config file). No shared TypeScript libraries between apps — they communicate only over HTTP.

## Commands

```bash
npm run build           # turbo run build (api: tsc -p . → dist/; dashboard: next build)
npm run dev             # both apps under Portless (https://kizuna.localhost + https://api.kizuna.localhost)
npm run dev:api         # API only (turbo --filter=@kizuna/api)
npm run dev:dashboard   # Dashboard only (turbo --filter=@kizuna/dashboard)
npm run typecheck       # turbo run typecheck (tsc --noEmit on both apps)
npm run test            # turbo run test (api: vitest; dashboard has no tests)
npm run lint            # turbo run lint (eslint @kizuna/eslint-config)
```

Both apps run under [Portless](https://github.com/vercel-labs/portless): API at `https://api.kizuna.localhost`, dashboard at `https://kizuna.localhost`. Each `dev` script wraps the framework launcher with `portless run …`. Standalone fallback ports are `3000` (API, from `config.PORT`) and Next.js's default for the dashboard, but normal `npm run dev` never binds to those — Portless picks an ephemeral port and proxies the named URL to it.

The api workspace also exposes:

```bash
cd apps/api
npm run test:watch      # vitest watch
npm run lint:fix
npx tsx scripts/import-vcards.ts <path-to.vcf>   # bulk-create people from vCard
```

## Dependency Graph

```
@kizuna/typescript-config  ← leaf
@kizuna/eslint-config      ← leaf
       ↑
@kizuna/api          ← Express, Mongoose, Gmail/Calendar ingest
@kizuna/dashboard    ← Next.js 15 (talks to API over HTTP via KIZUNA_API_URL)
```

The two apps share **no in-process code**. The dashboard's contract with the API is the REST surface in `apps/api/src/routes/*` plus the OAuth handlers, hit through `fetch` to `KIZUNA_API_URL` (default `https://api.kizuna.localhost`). The dashboard mirrors the API's serialized shapes by hand in `apps/dashboard/lib/types.ts` — keep that file in sync with `apps/api/src/lib/serialize.ts` when shapes change.

## Conventions

- **TypeScript + ESM** — strict mode, ES2023 target, NodeNext for the API; bundler resolution + `module: ESNext` for the dashboard. Server config sets `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `noImplicitOverride`.
- **Async everywhere** — all I/O is async/await, no callbacks.
- **Zod at boundaries** — every request body / query / params parsed by zod in the route handler; the global error handler maps `ZodError` to `400 { error: { code: "bad_request", message: "invalid input", details } }`. Internal modules trust their inputs.
- **Pino logging** — singleton in `apps/api/src/lib/logger.ts`, `pino-pretty` in `NODE_ENV=development`. `logger.info({ context }, "message")` pattern. There is no `pino-http` middleware today; route logging is request-scoped only via thrown errors hitting `makeErrorHandler`.
- **No classes for services** — routers, ingest workers, parsers are all standalone exported functions. The only classes are `HttpError`, `OAuthError`, `GmailHttpError`, `CalendarHttpError`, and `SyncTokenExpired` — all error envelopes.
- **Mongoose `strict: 'throw'` everywhere** — every model uses `baseSchemaOptions = { timestamps: true, strict: 'throw', versionKey: false }`. Unknown fields on write reject the insert, which the error handler turns into a `400 bad_request`. Combined with zod-strict request bodies, this is two layers of contract enforcement.
- **Provenance fields on every doc** — every model spreads `provenanceFields = { source, sourceVersion?, deletedAt: null }` from `db/models/base.ts`. `source` is one of `'concierge' | 'gmail-sync' | 'gcal-sync' | 'manual' | 'import'`.
- **Soft delete via `deletedAt`** — DELETE handlers never remove rows; they `findOneAndUpdate` with `{ deletedAt: new Date() }`. List endpoints filter `deletedAt: null` unless `?includeTombstoned=true`. Person tombstones additionally set `suppressReingest: true` so the upsert path won't recreate them.
- **AES-256-GCM for OAuth tokens** — Google refresh tokens are encrypted at rest with `KIZUNA_OAUTH_ENCRYPTION_KEY` (a base64 32-byte key). See `apps/api/src/lib/encryption.ts`. The IV is random per write, the auth tag is appended, and the envelope is `base64(iv ‖ tag ‖ ciphertext)`.
- **Bearer auth on `/v1/*`** — every authed route checks `Authorization: Bearer <KIZUNA_API_KEY>` via constant-time compare. OAuth handlers accept the same key as `?key=` for browser-initiated `<a href>` flows; the OAuth callback is gated by HMAC-signed CSRF state instead.
- **Cross-package imports** — `@kizuna/typescript-config`, `@kizuna/eslint-config` only.
- **Within-package imports (API)** — relative paths with explicit `.js` extensions (NodeNext requirement).
- **Within-package imports (dashboard)** — `@/*` path aliases (e.g. `@/lib/api`, `@/components/ui/button`); no extensions.
- **`.env` location** — `apps/api/.env` and `apps/dashboard/.env`. `apps/api/.env.example` and `apps/dashboard/.env.example` are templates.
- **Tests as source of truth** — when a test fails because production behaves differently than the test expects, fix the API, not the test. See [docs/testing.md](docs/testing.md).
- **Internal packages pattern** — both `packages/*` are config-only (JSON exports / flat ESLint configs). No build step.

## Doc Maintenance

After any code change, update the relevant doc in `/docs` to reflect the change. If a new module or major feature is added, create a new doc file. Keep docs accurate — they are the primary architecture reference.

See `/docs` for:

- [architecture.md](docs/architecture.md) — system overview, request flow, dependency graph, boot sequence, design decisions
- [api.md](docs/api.md) — REST surface (`/v1/*`, OAuth, `_manifest`), auth model, error envelope, request/response shapes
- [data-model.md](docs/data-model.md) — Mongoose models (Person, Interaction, Followup, Organization, OAuthToken, SyncState), indexes, the `recordInteraction` writer
- [sync.md](docs/sync.md) — Gmail + Calendar ingest pipeline (state machines, cursors, dedup via `sourceRef`, scheduler)
- [auth.md](docs/auth.md) — Bearer token model, USER_EMAILS allowlist, AES-256-GCM token encryption, signed CSRF state, dashboard cookie sessions
- [dashboard.md](docs/dashboard.md) — Next.js inspector pages, design system ("Mashiro Daylight"), data flow
- [configuration.md](docs/configuration.md) — env vars, encryption-key generation, common setups, Portless
- [testing.md](docs/testing.md) — vitest + supertest + testcontainers harness, what's covered, patterns
