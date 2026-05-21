# CLAUDE.md

## Project

Kansoku (観測, "observation") — the workspace's observability service. Ingests structured logs, traces, errors, and metrics from Kioku, Kokoro, and Kizuna over HTTP; stores them in MongoDB (time-series collections); exposes a Next.js dashboard for live tail, search, trace waterfalls, and grouped errors. Built with TypeScript, Express, Pino, MongoDB, and Next.js — the same stack as the sibling services so contributors don't re-learn anything.

Kansoku follows Kioku's "pull-only-equivalent" posture inverted: it is **push-only-in**. It never initiates outbound calls to siblings. Failure of Kansoku must never cascade — every shipper is fail-open at the call site.

This file is the project guide. Cross-service facts live in the workspace root: see [`../CLAUDE.md`](../CLAUDE.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Status

**Phase 8 — prod-hardening (branch `logging-prod-hardening`, not yet on `main`).** On top of Phases 0–7:

- **Wire format is ECS / OTel** (`log.level`, `@timestamp`, `service.{name,environment,component}`, `host.name`, `process.pid`, `trace.id`, `span.{id,parent.id}`, `error.{type,message,stack_trace}`, `message`). `lib/envelope.ts` tolerantly accepts BOTH the ECS shape and the legacy flat form and normalizes both to the unchanged internal `StoredLog`, so queries/metrics/errors/dashboard are untouched and producers/consumer needn't restart in lock-step.
- **Build-light spans.** `@kagami/logger`'s `runWithSpan` emits `event.kind:"span"` log lines; `storage/spans.ts` folds them into a regular `spans` collection (`_id = traceId:spanId`); `GET /v1/traces/:id` returns `{ logs, spans }`; the dashboard renders a real waterfall (graceful fallback to the log-derived approximation for old traces).
- **Durability + sampling + cardinality.** Ingest is write-then-ack (503 → shipper requeues); `KANSOKU_ERRORS_TTL_DAYS` (90) and the logs TTL on `spans`; `KANSOKU_MAX_META_COMBOS` (1000) cardinality budget (`lib/cardinality.ts`). Fixed a pre-existing `recordErrors` bug that silently dropped every traced error.

**Phase 7 — retention dial-in + new-error alerts live.** On top of Phases 0–6:

- `KANSOKU_LOGS_TTL_DAYS` (default 30, capped 365) tunes the `logs` time-series TTL. `ensureIndexes` reconciles via `collMod` on every startup — bump the env, restart, done.
- `KANSOKU_ALERT_WEBHOOK_URL` fires a small JSON POST when a brand-new error fingerprint shows up (`upsertedCount > 0` on the errors registry upsert). Discord/Slack-shaped payload: `{ kind, fingerprint, service, component, name?, message, firstSeen, traceId? }`. Fail-open, 5 s timeout, never wedges ingest. Re-occurrences of an existing fingerprint don't re-alert.

**Phase 6 — derived metrics live.** On top of Phases 0–5:

- `GET /v1/services?windowHours=N` returns one row per service with `count`, `errorCount`, `warnCount`, `lastSeen`, distinct `components` — computed by `$group` over the existing `logs` index. No second ingestion pipeline.
- `GET /v1/services/:service/timeline?windowHours=N&granularity=…` returns sparse `{ ts, count, errorCount }` buckets. Granularity auto-picks `minute`/`hour`/`day` based on the window.
- Dashboard `/services` joins the sidebar with a per-service grid: log count, error count, error %, volume sparkline, optional error-rate sparkline, last-seen relative time. Window selection (1h / 6h / 24h / 7d) is a querystring switch. Each card links straight into `/search?service=<svc>`.

**Phase 5 — full workspace rollout.** On top of Phases 0–4:

- **Kokoro** — `@kokoro/shared`'s logger picks up `KANSOKU_URL` / `KANSOKU_INGEST_TOKEN` from config and installs the Kansoku shipper. Grammy middleware at the top of `createBot` wraps every Telegram update in `runWithTrace`; the BlueBubbles webhook does the same per inbound request (honoring an incoming `traceparent` when present). The Kioku client (`@kokoro/memory`) and the Kizuna client (`@kokoro/kizuna`) both call `tracedFetch` so the active span propagates onto the wire. (Note: `@kagami/logger` no longer ships secret/PII redaction — the workspace is local-trust only; redaction must be reintroduced before any non-localhost exposure.)
- **Kizuna** — `kizuna/apps/api/src/lib/logger.ts` opts into the shipper via env. `createApp` mounts `traceMiddleware` before any route, so every log emitted under a request — including the Kokoro-originated CRM calls — carries the right `traceId` / `spanId`.
- **`@kokoro/shared` re-exports** `tracedFetch`, `runWithTrace`, `newTraceContext`, `parseTraceparent`, and `getTraceContext` so sibling Kokoro packages don't need their own `@kagami/logger` dep.

End-to-end follow-along: a Telegram message now generates a root trace in Kokoro that Kioku and Kizuna join via `traceparent`. Every log line on every hop carries the same `traceId`, viewable on the dashboard's `/traces/[id]` waterfall.

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
│   │   │   │   ├── errors.ts    # GET /v1/errors (fingerprinted error registry)
│   │   │   │   └── services.ts  # GET /v1/services (+ /:service/timeline) — derived metrics
│   │   │   ├── storage/
│   │   │   │   ├── mongo.ts     # lazy MongoClient singleton
│   │   │   │   ├── indexes.ts   # time-series + btree + TTL indexes (logs/errors/spans)
│   │   │   │   ├── logs.ts      # StoredLog type, insertLogs, queryLogs, queryTrace
│   │   │   │   ├── errors.ts    # ErrorRecord type, recordErrors, listErrors
│   │   │   │   ├── spans.ts     # StoredSpan, extractSpan, recordSpans, querySpansByTrace
│   │   │   │   └── metrics.ts   # serviceSummary + serviceTimeline aggregations
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts      # constant-time x-kansoku-auth check
│   │   │   │   ├── envelope.ts  # ECS + legacy tolerant parse → StoredLog normalizer
│   │   │   │   ├── cardinality.ts # metaField distinct-tuple budget guard
│   │   │   │   ├── cors.ts      # *.localhost echo for the dashboard
│   │   │   │   ├── log-events.ts # in-process broadcaster + 500-entry ring
│   │   │   │   ├── fingerprint.ts # error signature builder (ECS + legacy error shapes)
│   │   │   │   └── alerts.ts    # fail-open webhook for new error fingerprints
│   │   │   ├── server.ts        # createApp() + main() boot
│   │   │   └── logger.ts        # @kagami/logger wrapper
│   │   ├── tests/               # vitest + mongodb-memory-server harness
│   │   ├── scripts/             # kansoku-debug CLI (read-only observability window)
│   │   ├── tsconfig.json        # extends @kagami/tsconfig/server.json
│   │   ├── tsconfig.build.json  # prod build: tsc -p this → dist/ (extends @kagami/tsconfig/server.build.json)
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
│       │   │   ├── services/page.tsx    # per-service volume + error-rate cards
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

## Debugging from the command line

`scripts/kansoku-debug.ts` is an agent-friendly read-only CLI over the Kansoku query surface — use it when you have a trace ID, an error message, or a time window and want to inspect what happened without opening the dashboard. Requires `npm run kansoku:dev:api` to be running.

```bash
# Full trace by 32-hex-char ID (waterfall + log timeline; error stacks
# appear inline in the timeline, truncated)
npm run kansoku:debug -- trace <traceId>

# Search logs. --service takes the exact stored name (kokoro-bot, kioku-api,
# kizuna-api, kansoku-api, kao-api), not a prefix. --since/--until are ISO.
npm run kansoku:debug -- logs --service kokoro-bot --level error --limit 50

# Fingerprinted error registry. CLI prints the last 5 recent trace IDs per
# fingerprint; use --json for all (up to 20 are stored server-side).
npm run kansoku:debug -- errors --service kioku-api

# Per-service log/error/warn counts (default window 24h)
npm run kansoku:debug -- services --window 6

# Add --json to any subcommand for raw API output
# Override the base URL with --url or the KANSOKU_URL env var
```

Typical agent debugging flow: `errors` → pick a fingerprint → `trace <recentTraceId>` for the full picture. Or: `logs --service X --level error --since …` → cross-reference the surfaced trace IDs.

## Dependency Graph

```
@kagami/eslint-config, @kagami/tsconfig, @kagami/logger (workspace-shared, in shared/packages/)
       ↑
@kansoku/api          ← Express server: ingest, query, tail (SSE), errors, services, alerts
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
- [dashboard.md](docs/dashboard.md) — Next.js page map, SSE wire format, caching, a11y conventions
- [configuration.md](docs/configuration.md) — full env-var reference, token rotation, retention behavior
- [testing.md](docs/testing.md) — vitest + mongodb-memory-server harness, per-suite coverage table
