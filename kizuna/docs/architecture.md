# Architecture

## System Overview

Kizuna is a personal CRM. Two apps: an Express API that owns the database and Google ingest workers, and a Next.js dashboard that reads it. Lives as a subtree inside the Kagami nested monorepo (npm workspaces + Turborepo, orchestrated from the Kagami root) and consumes shared tooling via `@kagami/eslint-config` and `@kagami/tsconfig` from `shared/packages/`. The API is also consumed by Kokoro's CRM tools (reads direct, writes confirmation-gated); Kizuna itself has no outbound runtime references to Kioku or Kokoro.

### Monorepo Layout

```
kizuna/                              # subtree within the Kagami nested monorepo
├── apps/
│   ├── api/                         # Express HTTP API
│   │   ├── src/
│   │   │   ├── main.ts              # boot: loadConfig → connectDb → createApp → ingestScheduler
│   │   │   ├── server.ts            # Express app builder + middleware mount order
│   │   │   ├── config.ts            # zod env schema; throws on misconfig
│   │   │   ├── db/
│   │   │   │   ├── connect.ts       # mongoose.connect + syncIndexes + ping/close handle
│   │   │   │   ├── models/          # Person, Organization, Interaction, Followup, SyncState, base
│   │   │   │   └── recordInteraction.ts  # the only insert path for interactions
│   │   │   ├── ingest/
│   │   │   │   ├── scheduler.ts     # setInterval-driven Gmail + Calendar tick
│   │   │   │   ├── gmail.ts         # bootstrap (date window) → incremental (history)
│   │   │   │   ├── gmail-client.ts  # fetch wrapper around Gmail REST; self-heals on 401 via Kao
│   │   │   │   ├── parse-message.ts # Gmail JSON → ParsedMessage (pure)
│   │   │   │   ├── calendar.ts      # bootstrap → sync-token incremental + reconciliation
│   │   │   │   ├── calendar-client.ts # fetch wrapper around Calendar REST; self-heals on 401 via Kao
│   │   │   │   ├── parse-event.ts   # Calendar event → ParsedEvent (pure)
│   │   │   │   └── upsert-person.ts # find-or-create by lowercased email
│   │   │   ├── lib/
│   │   │   │   ├── kao-client.ts    # Kao token vend + cache + grant-status reshape (translates Kao errors → OAuthError)
│   │   │   │   ├── errors.ts        # HttpError + zod/mongoose error mapper
│   │   │   │   ├── cursor.ts        # base64url-encoded JSON cursor
│   │   │   │   ├── duration.ts      # ISO duration parser (P7D, PT12H, "7d")
│   │   │   │   ├── serialize.ts     # mongo doc → wire shape
│   │   │   │   └── logger.ts        # pino singleton
│   │   │   ├── routes/              # one router per resource (people, organizations, interactions, followups, contexts, digest, oauth, sync, health)
│   │   │   └── schemas/common.ts    # Pagination, IdParam, ISODateString, BoolFlag
│   │   ├── tests/                   # vitest + supertest + mongodb-memory-server
│   │   ├── scripts/import-vcards.ts # vCard → POST /people
│   │   └── tsconfig.build.json      # prod build: tsc -p this → dist/ (extends @kagami/tsconfig/server.build.json)
│   └── dashboard/                   # Next.js 16 (App Router)
├── packages/                        # reserved for future Kizuna-only libs (currently empty)
├── portless.json                    # api.kizuna + kizuna registrations
└── docs/
```

Shared tooling (`@kagami/eslint-config`, `@kagami/tsconfig`) lives in Kagami's `shared/packages/` and is consumed by both apps. The API's `tsconfig.json` extends `@kagami/tsconfig/server.json` (with `verbatimModuleSyntax`, `noImplicitOverride`, `esModuleInterop` as overrides); the dashboard's extends `@kagami/tsconfig/nextjs.json` (with `verbatimModuleSyntax: false`, `allowJs: true`). For production the API has a sibling `tsconfig.build.json` (extends `@kagami/tsconfig/server.build.json`, emit on) so `npm run build` emits `dist/` and `start` runs `node dist/main.js`.

### Dependency Graph

```
@kagami/eslint-config  ← shared (Kagami shared/packages/)
@kagami/tsconfig       ← shared (Kagami shared/packages/)
       ↑
@kizuna/api          ← Express, Mongoose, ingest workers
@kizuna/dashboard    ← Next.js inspector — talks to API only over HTTP
```

The two apps share **no in-process code**. The dashboard's contract with the API is the REST surface in `apps/api/src/routes/*` plus the OAuth handlers, hit through `fetch` to `KIZUNA_API_URL` (default `https://api.kizuna.localhost`). The dashboard mirrors API response shapes by hand in `apps/dashboard/src/lib/types.ts` — keep that file in sync with `apps/api/src/lib/serialize.ts` when shapes change.

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                         External clients                          │
│   Kokoro CRM client · Dashboard (server fetch) ·                   │
│   import-vcards.ts script · Browser (OAuth flow)                  │
└────────────────┬───────────────────────────────────┬──────────────┘
                 │ REST                              │ OAuth redirects
                 ▼                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                    @kizuna/api (Express 5)                        │
│                                                                   │
│  health      (open)                                               │
│  /oauth/*    (start/status open; callback uses HMAC state)        │
│  resource routes (open at single-user localhost)                  │
│      │                                                            │
│      ├── routes/people · interactions · followups ·               │
│      │   organizations · contexts · digest · sync                 │
│      ▼                                                            │
│  db/recordInteraction.ts        (only insert path; touches        │
│                                  Person.lastInteractionAt via $max) │
│      │                                                            │
│      ▼                                                            │
│  Mongoose models (strict:'throw', soft-delete via deletedAt)      │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                MongoDB (default mongodb://127.0.0.1:27017/kizuna) │
│  people · organizations · interactions · followups · syncstates  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│              In-process ingest scheduler                          │
│  setInterval(KIZUNA_INGEST_INTERVAL_SEC * 1000)                   │
│   ├─ runGmailSyncOnce(config)   →  gmail-client → Gmail REST     │
│   └─ runCalendarSyncOnce(config) →  calendar-client → Calendar   │
│  Re-entrancy guard skips overlapping ticks                        │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                Google APIs (HTTP, OAuth-bearer)                   │
│  Gmail: users.messages, users.history (gmail.readonly)            │
│  Calendar: events.list (calendar.readonly, syncToken-incremental) │
│  Access tokens vended by Kao at /grants/kizuna/token (bearer).    │
│  In-process cache (expiry − 30 s buffer); 401 → ?force=1 retry.   │
└──────────────────────────────────────────────────────────────────┘
```

## Request Flow

### Resource Routes (people, interactions, etc.)

```
1. express.json({ limit: "1mb" }) parses the body.
       │
2. Route handler parses req.body / req.query / req.params via zod.
       │
3. Mongoose model call (find / findOneAndUpdate / aggregate). Soft-delete
   filter (deletedAt: null) applied unless ?includeTombstoned=true.
       │
4. Hit (200/201/404) → serializer in lib/serialize.ts → res.json.
       │
5. ZodError / mongoose ValidationError / dup-key (E11000) flow up to
   makeErrorHandler() and become a tagged JSON envelope with the
   right status (400 / 409 / 500).
```

### OAuth grant (`/oauth/google/start` → Kao)

```
1. POST /oauth/google/start: require KAO_URL + KAO_TOKEN; check Origin (allowlist of dashboard origins); clear pausedAt + errorCount on paused workers; 303 to
   ${KAO_URL}/oauth/kizuna/start. Kizuna's role ends here.
       │
2. Kao mints a signed CSRF state bound to grant='kizuna'; redirects to
   Google with the registered ${KAO_PUBLIC_URL}/oauth/callback URI.
       │
3. Browser → Google → ${KAO_URL}/oauth/callback?code=…&state=….
       │
4. Kao verifies state, exchanges the code, AES-256-GCM-encrypts the
   refresh token, upserts grants.kizuna in Kao's Mongo, and returns its
   "Granted ✓" landing page.
       │
5. Next call to getAccessToken(config) (Kizuna side) hits
   ${KAO_URL}/grants/kizuna/token and gets a fresh access token. To
   un-pause workers stalled on invalid_grant, POST /sync/*/run with
   { force: true } — Kao has no knowledge of Kizuna's SyncState.
```

### Gmail sync tick (`POST /sync/gmail/run` or scheduler)

```
1. loadOrInitState() — upsert SyncState{ provider:'gmail' }.
       │
2. If pausedAt is set and force !== true → return { status: 'paused' }.
       │
3. getAccessToken(config) — Kao-backed: cached in-process if not
   expired-30s, else GET ${KAO_URL}/grants/kizuna/token. Kao 409 →
   OAuthError → pauseWith. The Gmail/Calendar clients self-heal on a
   single Google 401 via getAccessToken({force:true}); a persistent 401
   escapes as GmailHttpError(401) and pauses.
       │
4. If state.historyId is null:  bootstrap(client, config, result):
       a. profile = users.getProfile().
       b. q = `after:YYYY/M/D` for KIZUNA_GMAIL_BACKFILL_DAYS ago.
       c. paginate users.messages.list(q) → flat list of message IDs.
       d. processMessageIds(...).
       e. return profile.historyId.
   Else:  incremental(state.historyId, client, config, result):
       a. paginate users.history.list({ startHistoryId, historyTypes:
          messageAdded }) → set of new message IDs.
       b. processMessageIds(...).
       c. return latest seen historyId.
       │
5. processMessageIds(ids):  for each id —
       a. users.messages.get({ id, format: full }).
       b. parseGmailMessage(raw) → ParsedMessage (subject, from/to/cc,
          bodyText, attachments, hasListUnsubscribe).
       c. If hasListUnsubscribe OR sender domain in NEWSLETTER_DOMAIN_BLOCKLIST
          → result.skippedNewsletter++; continue.
       d. Skip-self on group emails: drop USER_EMAILS recipients from
          to/cc when ≥ 2 others remain. The from role is preserved.
       e. upsertPerson({ email, displayName, occurredAt, source:
          'gmail-sync' }) for each remaining address.
       f. recordInteraction({ channel: 'email', sourceRef:
          { provider:'gmail', id }, ... }, { skipIfDuplicate: true }) —
          unique partial index on (sourceRef.provider, sourceRef.id)
          makes replays idempotent.
       │
6. recordSuccessfulRun(historyIdAfter) — set lastRunAt + clear lastError;
   write historyId only if non-null.
       │
7. Return { status, fetched, inserted, skippedExisting, skippedNewsletter,
            errors, historyIdAfter }.
```

The Calendar tick is structurally identical except:

- bootstrap is `events.list({ timeMin })` over `KIZUNA_GCAL_BACKFILL_DAYS`,
- incremental uses `syncToken` rather than `historyId`,
- 410 Gone on syncToken triggers `clearSyncToken()` + re-bootstrap (`resyncedFromBootstrap = true`),
- the writer is `upsertInteractionBySourceRef` (not `recordInteraction`) so reconciled edits to existing events overwrite title/time/location/status/participants instead of duplicating,
- cancelled events are written with `status: 'cancelled'` and don't bump `lastInteractionAt`.

See [sync.md](sync.md) for the full state machine.

## Boot Sequence

`apps/api/src/main.ts`:

1. `import 'dotenv/config'` — pick up `apps/api/.env`.
2. `loadConfig()` — zod-parse `process.env`. Throws with formatted issues on misconfig.
3. `connectDb(MONGODB_URI)` — `mongoose.connect` (5 s server-selection timeout) + `mongoose.syncIndexes()` for every registered model. Returns a `DbHandle` exposing `ping()` and `close()`.
4. `createApp({ db, config })` — builds the Express app: disables `x-powered-by`, mounts `express.json({ limit: '1mb' })`, then `health` (open), `/oauth/*` (start/status open; callback uses signed CSRF state), resource routers (open at single-user localhost), a 404 handler, and finally `makeErrorHandler()`.
5. `app.listen(config.PORT, config.KIZUNA_HOST, …)` — Portless injects `PORT` under the normal `dev` script and routes `https://api.kizuna.localhost` to it. The API's `127.0.0.1:3000` default is only a standalone fallback outside Portless.
6. `startIngestScheduler({ config })` — `setInterval` every `KIZUNA_INGEST_INTERVAL_SEC` seconds (no startup tick — first run is one interval after boot, to avoid surprise sync runs on `tsx watch` reloads). When the env var is `0`, the scheduler is a no-op and ingest runs only via `POST /sync/{gmail,gcal}/run`.
7. SIGINT / SIGTERM → stop scheduler → `server.close()` → `db.close()` → `process.exit(0)`. There is no app-level `SIGINT` handler for in-flight requests — Express's default is to stop accepting and let the active ones drain.

## Key Design Decisions

- **Hand-rolled Google clients.** `googleapis` would be the natural fit but pulls a heavy GAX runtime. `apps/api/src/ingest/gmail-client.ts` and `apps/api/src/ingest/calendar-client.ts` are thin `fetch` wrappers that take an injected `getAccessToken` so the workers can be unit-tested with a fake. Each Google request uses a 30-second `AbortSignal.timeout`; timeouts surface as stable `SyncState.lastError` codes (`gmail_request_timeout` / `gcal_request_timeout`) without advancing cursors. On a 401/403 the client calls `getAccessToken({ force: true })` (which tells Kao to bypass its cache via `?force=1`) and retries once — Google revoking the access token mid-cache-window recovers automatically without a worker pause.
- **One write path for interactions.** `db/recordInteraction.ts` is the only module that inserts into `interactions`. It updates `Person.lastInteractionAt` via `$max` for every linked participant in the same call so the read-side denormalization is always consistent. Two paths exist on top: `recordInteraction` (insert; rejects duplicates if `skipIfDuplicate` is set, returning `null`) and `upsertInteractionBySourceRef` (upsert; replaces title/time/location/participants wholesale; cancelled events skip the `lastInteractionAt` bump).
- **Soft delete + tombstone semantics.** DELETE handlers `findOneAndUpdate` with `{ deletedAt: new Date() }`. Person tombstones additionally set `suppressReingest: true` so the live Gmail/Calendar sync won't recreate the row through `upsertPerson`. The `?includeTombstoned=true` flag on list endpoints surfaces them — the dashboard's `/tombstones` page is built on this.
- **Dedup by `sourceRef`.** `Interaction.sourceRef = { provider, id }` carries Gmail's message ID or Calendar's event ID. A unique partial index `(sourceRef.provider, sourceRef.id)` enforces "one interaction per Gmail message" and "one per Calendar event"; ingest workers replay safely. Concierge-created interactions have `sourceRef: null` and are exempt.
- **Skip-self on group threads.** When ≥ 2 non-user recipients remain, USER_EMAILS addresses are dropped from `to/cc` so the dashboard's relationship graph doesn't bloat with self-edges. The `from` role is preserved either way, which is what makes the dashboard's "outbound" badge work.
- **Google identity is delegated to Kao.** Kizuna does not own a Google refresh token, an encryption key, or a CSRF secret — all three live in Kao (`kao/apps/api/src/lib/encryption.ts` and `kao/apps/api/src/lib/oauth-state.ts`). The only Google-related credential here is `KAO_TOKEN`, the bearer that gates `${KAO_URL}/grants/kizuna/token`. Kizuna's `POST /oauth/google/start` is a 303 to `${KAO_URL}/oauth/kizuna/start` (POST + same-origin Origin check defends against cross-origin form-CSRF from a malicious tab); `/oauth/google/status` is a server-side proxy that reshapes Kao's grant row to the `OAuthStatus` envelope (with a `reason` hint that distinguishes wrong `KAO_TOKEN` from "no consent yet" so the dashboard renders an actionable message instead of looping the operator through Connect-Google clicks).
- **In-process scheduler, no queue.** Ingest is a setInterval loop with a re-entrancy guard. Tradeoff: simpler ops, no external broker, no horizontal scale; for a single-user CRM this is fine. The manual triggers (`POST /sync/{gmail,gcal}/run`) work regardless of the scheduler.
- **Two layers of contract enforcement.** Zod-strict request bodies (`.strict()`) reject unknown fields at the route boundary; Mongoose `strict: 'throw'` rejects them at the model boundary. Both surface as `400 bad_request`. Belt and suspenders, on the theory that a CRM's data quality is the product.
- **Cursor pagination, base64url JSON.** `apps/api/src/lib/cursor.ts`. Most cursors are `{ id }` (descending `_id`); the people list under `sort=lastInteractionAt:-1` uses a compound `{ lia, id }` cursor with a trailing-null bucket so people who've never had an interaction sort last but stay paginable.
- **Pull-only by design (system level).** Kizuna exposes an API consumed by the dashboard and Kokoro, but it never initiates outbound calls to sibling services in the Kagami workspace. Its only outbound network calls are to Google.

## Module Map

| Directory                              | Purpose                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/db/models/`              | Mongoose schemas (Person, Organization, Interaction, Followup, SyncState) + `base.ts` provenance fields. See [data-model.md](data-model.md).                                                     |
| `apps/api/src/db/recordInteraction.ts` | The only insert path for `interactions`; maintains `Person.lastInteractionAt`.                                                                                                                   |
| `apps/api/src/ingest/`                 | Gmail + Calendar workers (state machines, paging, error mapping), pure parsers, `upsertPerson`, in-process scheduler. See [sync.md](sync.md).                                                    |
| `apps/api/src/routes/`                 | One Express router per resource. Route handlers own both zod validation and response serialization.                                                                                              |
| `apps/api/src/lib/`                    | Cross-cutting helpers — error envelope, Kao-backed access-token vend + cached access token + grant-status reshape, base64url cursor, ISO duration parser, mongo→wire serializer, pino singleton. |
| `apps/dashboard/src/app/`              | Next.js 16 App Router. Single `(app)` route group; no login. See [dashboard.md](dashboard.md).                                                                                                   |
| `apps/dashboard/src/lib/`              | Typed API client, hand-mirrored response types, formatters.                                                                                                                                      |

## Cross-cutting Concerns

- **Logging.** `apps/api/src/lib/logger.ts` is a thin wrapper around `@kagami/logger`'s `createLogger`, which provides stable `service`/`component`/`env` bindings, ECS / OTel field names, an `error`-key serializer, TTY/`LOG_PRETTY`-gated console formatting, and the optional fail-open Kansoku shipper when `KANSOKU_URL` + `KANSOKU_INGEST_TOKEN` are set. There is no secret/PII redaction today (local-trust only). Used directly in workers / boot / errors; there's no request-scoped logger middleware today.
- **Error handling.** `apps/api/src/lib/errors.ts` defines a `HttpError` class and an `errors.{badRequest,unauthorized,notFound,conflict,rateLimited,internal}` factory. The Express error handler maps `HttpError` → tagged 4xx, `ZodError` → `400 bad_request`, Mongoose `ValidationError` / `CastError` / `StrictModeError` → `400 bad_request`, code-11000 dup-key → `409 conflict`, everything else → `500 internal`.
- **Time handling.** All dates are stored as `Date` and serialized as ISO 8601. The dashboard formats in `America/New_York` (`apps/dashboard/src/lib/format.ts`) — hardcoded for now.
- **Reentrancy on ingest.** The scheduler keeps a `running = true` flag while a tick is in flight; overlapping ticks are skipped with a `logger.warn`. Manual `POST /sync/.../run` calls bypass this — they're synchronous round-trips driven by the caller.
- **Access-token caching.** `apps/api/src/lib/kao-client.ts` caches the Google access token in module scope, refreshed when `expiresAt < now + 30 s`. Concurrent vend calls share one in-flight HTTP round-trip. `getAccessToken({ force: true })` clears both the local cache and the inflight slot, and propagates `?force=1` to Kao so Kao bypasses **its** cache too — used by the gmail/calendar clients on a Google-side 401. The cache is process-local; in a multi-instance deploy each worker would keep its own copy (Kao itself is the shared one).
