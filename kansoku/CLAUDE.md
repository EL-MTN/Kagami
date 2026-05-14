# CLAUDE.md

## Project

Kansoku (観測, "observation") — the workspace's observability service. Ingests structured logs, traces, errors, and metrics from Kioku, Kokoro, and Kizuna over HTTP; stores them in MongoDB (time-series collections); exposes a Next.js dashboard for live tail, search, trace waterfalls, and grouped errors. Built with TypeScript, Express, Pino, MongoDB, and Next.js — the same stack as the sibling services so contributors don't re-learn anything.

Kansoku follows Kioku's "pull-only-equivalent" posture inverted: it is **push-only-in**. It never initiates outbound calls to siblings. Failure of Kansoku must never cascade — every shipper is fail-open at the call site.

This file is the project guide. Cross-service facts live in the workspace root: see [`../CLAUDE.md`](../CLAUDE.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Status

**Phase 4 — error fingerprinting live.** On top of Phases 0–3:

- Every `error`/`fatal` log line hits `fingerprintErrorLog` (`apps/api/src/lib/fingerprint.ts`). The signature is a sha1 of `service ␟ error.name ␟ normalized(message) ␟ first non-internal stack frame`; the normalizer replaces ISO timestamps, UUIDs, Mongo ObjectIds, and long numeric runs with placeholders so the same failure with varying IDs collapses to one fingerprint.
- The ingest path upserts each fingerprint into a regular `errors` collection (keyed by fingerprint, indexed by `lastSeen` and `(service, lastSeen)`). `$setOnInsert` keeps the first sample untouched, `$set` updates `lastSeen`, `$inc` bumps `count`, `$push` appends `traceId` (slice-capped at 20). Failure is fail-open and never wedges the bulk log write.
- `GET /v1/errors?service=&limit=` returns the registry sorted by `lastSeen` desc.
- Dashboard `/errors` lists each group with name + message, service/component, count, relative first/last-seen, and an arrow link to the most recent trace.

Kokoro and Kizuna get the trace middleware (and Kokoro's HTTP clients get swapped to `tracedFetch`) in Phase 5.

See [`docs/architecture.md`](docs/architecture.md) for the full plan.

## Monorepo Structure

```
kansoku/                # subtree of the Kagami workspace; no project-local package.json / turbo.json
├── apps/
│   ├── api/            # Express HTTP server (entry: src/server.ts)
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── meta.ts      # /health, /version
│   │   │   │   ├── ingest.ts    # POST /v1/logs (HMAC token, Zod, async insert)
│   │   │   │   ├── query.ts     # GET /v1/logs + GET /v1/traces/:id
│   │   │   │   ├── tail.ts      # GET /v1/tail (SSE with filter + replay)
│   │   │   │   └── errors.ts    # GET /v1/errors (fingerprinted error registry)
│   │   │   ├── storage/
│   │   │   │   ├── mongo.ts     # lazy MongoClient singleton
│   │   │   │   ├── indexes.ts   # time-series + btree indexes, 30-day TTL
│   │   │   │   ├── logs.ts      # StoredLog type, insertLogs, queryLogs, queryTrace
│   │   │   │   └── errors.ts    # ErrorRecord type, recordErrors, listErrors
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts      # constant-time x-kansoku-auth check
│   │   │   │   ├── envelope.ts  # Zod schema + pino → StoredLog normalizer
│   │   │   │   ├── cors.ts      # *.localhost echo for the dashboard
│   │   │   │   ├── log-events.ts # in-process broadcaster + 500-entry ring
│   │   │   │   └── fingerprint.ts # error signature builder + normalizer
│   │   │   ├── server.ts        # createApp() + main() boot
│   │   │   └── logger.ts        # @kagami/logger wrapper
│   │   ├── tests/               # vitest + mongodb-memory-server harness
│   │   ├── tsconfig.json        # extends @kagami/tsconfig/server.json
│   │   ├── eslint.config.js
│   │   └── package.json
│   └── dashboard/      # Next.js 16 inspector at https://kansoku.localhost
│       ├── src/
│       │   ├── app/
│       │   │   ├── layout.tsx           # sidebar shell
│       │   │   ├── page.tsx             # overview
│       │   │   ├── tail/                # live SSE stream UI
│       │   │   │   ├── page.tsx
│       │   │   │   └── tail-client.tsx
│       │   │   ├── search/page.tsx      # historical filter form
│       │   │   ├── traces/[id]/page.tsx # waterfall + flat log timeline
│       │   │   ├── errors/page.tsx      # fingerprinted error groups
│       │   │   └── globals.css
│       │   ├── components/              # sidebar, nav-link, log-row, level-badge, shell
│       │   └── lib/                     # api, format, utils (cn)
│       ├── tsconfig.json        # extends @kagami/tsconfig/nextjs.json
│       ├── eslint.config.mjs
│       └── package.json
├── portless.json       # api.kansoku + kansoku Portless registrations
└── docs/
    └── architecture.md
```

Kansoku is a subtree inside the Kagami nested monorepo. The Kagami workspace root owns `package.json`, `turbo.json`, and `package-lock.json`; npm workspaces and Turborepo span every sibling project. Tooling is shared via the workspace-level `@kagami/eslint-config`, `@kagami/tsconfig`, and `@kagami/logger` packages.

## Commands

All commands run from the **Kagami workspace root**. To work on Kansoku in isolation, use the `kansoku:*` script aliases.

```bash
# From Kagami root:
./dev-all.sh                       # boot every project (Kansoku included)
npm run kansoku:dev                # both Kansoku apps under Portless
npm run kansoku:dev:api            # API only — https://api.kansoku.localhost
npm run kansoku:dev:dashboard      # Dashboard only — https://kansoku.localhost

npm run typecheck                  # turbo run typecheck across the workspace
npm run test                       # turbo run test
npm run lint                       # turbo run lint

# Filter to Kansoku only:
npx turbo run typecheck --filter="@kansoku/*"
npx turbo run test     --filter="@kansoku/*"
npx turbo run lint     --filter="@kansoku/*"
npx turbo run build    --filter="@kansoku/*"
```

Apps run under [Portless](https://github.com/vercel-labs/portless) at `https://kansoku.localhost` (dashboard) and `https://api.kansoku.localhost` (API). Portless injects `PORT`; `7779` is the standalone fallback for the API (chosen to avoid Kioku's `7777`).

## Dependency Graph

```
@kagami/eslint-config, @kagami/tsconfig, @kagami/logger (workspace-shared, in shared/packages/)
       ↑
@kansoku/api          ← Express server, ingest endpoints (Phase 1+)
@kansoku/dashboard    ← Next.js inspector (talks to API over HTTP via KANSOKU_API_URL)
```

Apps share no in-process code. The dashboard reaches the API only through `fetch` to `https://api.kansoku.localhost`.

## Conventions

- **TypeScript + ESM** — strict mode, ES2022 target, `NodeNext` module resolution for the API.
- **Async everywhere** — all I/O is async/await.
- **Zod at boundaries** — request bodies validated in `apps/api/src/routes/*`. Internal modules trust their inputs.
- **Pino logging** — structured logs via `logger.info({ context }, "message")` built from `@kagami/logger`. `pino-http` is mounted on the API.
- **Fail-open ingest** — every shipper at every call site swallows Kansoku errors. The observability layer must never wedge a sibling service.
- **No classes for services** — prefer standalone exported functions. Routers and ingest workers are all plain functions.
- **`.env` location** — `apps/api/.env` (not root). `apps/api/.env.example` is the template.
- **Within-package imports** — relative paths with explicit `.js` extensions (NodeNext requirement on the API).

## Doc Maintenance

After any code change, update the relevant doc in `/docs` to reflect the change. If a new module or major feature is added, create a new doc file. Keep docs accurate — they are the primary architecture reference.

See `/docs` for:

- [architecture.md](docs/architecture.md) — system overview, ingest path, data model, dashboard surfaces, phased delivery plan
