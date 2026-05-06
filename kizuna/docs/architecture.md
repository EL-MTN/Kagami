# Architecture

## System Overview

Kizuna is a personal CRM. Two apps: an Express API that owns the database and Google ingest workers, and a Next.js dashboard that reads it. Lives as a subtree inside the Kagami nested monorepo (npm workspaces + Turborepo, orchestrated from the Kagami root) and consumes shared tooling via `@kagami/eslint-config` and `@kagami/tsconfig` from `shared/packages/`. No runtime references to Kioku or Kokoro.

### Monorepo Layout

```
kizuna/                              # subtree within the Kagami nested monorepo
├── apps/
│   ├── api/                         # Express HTTP API
│   │   ├── src/
│   │   │   ├── main.ts              # boot: loadConfig → connectDb → createApp → ingestScheduler
│   │   │   ├── server.ts            # Express app builder + middleware mount order
│   │   │   ├── config.ts            # zod env schema; throws on misconfig
│   │   │   ├── manifest.ts          # zod-to-json-schema → /v1/_manifest
│   │   │   ├── db/
│   │   │   │   ├── connect.ts       # mongoose.connect + syncIndexes + ping/close handle
│   │   │   │   ├── models/          # Person, Organization, Interaction, Followup, OAuthToken, SyncState, base
│   │   │   │   └── recordInteraction.ts  # the only insert path for interactions
│   │   │   ├── ingest/
│   │   │   │   ├── scheduler.ts     # setInterval-driven Gmail + Calendar tick
│   │   │   │   ├── gmail.ts         # bootstrap (date window) → incremental (history)
│   │   │   │   ├── gmail-client.ts  # thin fetch wrapper around Gmail REST
│   │   │   │   ├── parse-message.ts # Gmail JSON → ParsedMessage (pure)
│   │   │   │   ├── calendar.ts      # bootstrap → sync-token incremental + reconciliation
│   │   │   │   ├── calendar-client.ts
│   │   │   │   ├── parse-event.ts   # Calendar event → ParsedEvent (pure)
│   │   │   │   └── upsert-person.ts # find-or-create by lowercased email
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts          # bearer-auth middleware (timingSafeEqual)
│   │   │   │   ├── encryption.ts    # AES-256-GCM envelope helpers
│   │   │   │   ├── google-auth.ts   # OAuth2Client + persistRefreshToken + cached access token
│   │   │   │   ├── oauth-state.ts   # HMAC-signed CSRF state
│   │   │   │   ├── errors.ts        # HttpError + zod/mongoose error mapper
│   │   │   │   ├── cursor.ts        # base64url-encoded JSON cursor
│   │   │   │   ├── duration.ts      # ISO duration parser (P7D, PT12H, "7d")
│   │   │   │   ├── serialize.ts     # mongo doc → wire shape
│   │   │   │   └── logger.ts        # pino singleton
│   │   │   ├── routes/              # one router per resource (people, organizations, interactions, followups, contexts, digest, oauth, sync, manifest, health)
│   │   │   └── schemas/common.ts    # Pagination, IdParam, ISODateString, BoolFlag, ListResponse
│   │   ├── test/                    # vitest + supertest + testcontainers (real Mongo)
│   │   └── scripts/import-vcards.ts # vCard → POST /v1/people
│   └── dashboard/                   # Next.js 15 (App Router)
├── packages/                        # reserved for future Kizuna-only libs (currently empty)
├── portless.json                    # api.kizuna + kizuna registrations
└── docs/
```

Shared tooling (`@kagami/eslint-config`, `@kagami/tsconfig`) lives in Kagami's `shared/packages/` and is consumed by both apps. The API's `tsconfig.json` extends `@kagami/tsconfig/server.json` (with `verbatimModuleSyntax`, `noImplicitOverride`, `esModuleInterop` as overrides); the dashboard's extends `@kagami/tsconfig/nextjs.json` (with `verbatimModuleSyntax: false`, `allowJs: true`).

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
│   Concierge agent (Bearer token) · Dashboard (server fetch) ·    │
│   import-vcards.ts script · Browser (OAuth flow)                 │
└────────────────┬───────────────────────────────────┬──────────────┘
                 │ REST                              │ OAuth redirects
                 ▼                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                    @kizuna/api (Express 5)                        │
│                                                                   │
│  health      (no auth)                                            │
│  /oauth/*    (key in header OR ?key= ; callback uses HMAC state)  │
│  /v1/*       (bearerAuth middleware)                              │
│      │                                                            │
│      ├── routes/people · interactions · followups ·               │
│      │   organizations · contexts · digest · sync · manifest      │
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
│  people · organizations · interactions · followups               │
│  · oauthtokens · syncstates                                       │
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
│  Refresh tokens encrypted with KIZUNA_OAUTH_ENCRYPTION_KEY        │
│  Access tokens cached in-process (expiry - 30 s buffer)           │
└──────────────────────────────────────────────────────────────────┘
```

## Request Flow

### Authed `/v1/*` (people, interactions, etc.)

```
1. express.json({ limit: "1mb" }) parses the body.
       │
2. bearerAuth(KIZUNA_API_KEY) — timingSafeEqual; 401 on miss.
       │
3. Route handler parses req.body / req.query / req.params via zod.
       │
4. Mongoose model call (find / findOneAndUpdate / aggregate). Soft-delete
   filter (deletedAt: null) applied unless ?includeTombstoned=true.
       │
5. Hit (200/201/404) → serializer in lib/serialize.ts → res.json.
       │
6. ZodError / mongoose ValidationError / dup-key (E11000) flow up to
   makeErrorHandler() and become a tagged JSON envelope with the
   right status (400 / 409 / 500).
```

### OAuth grant (`/oauth/google/start` → callback)

```
1. /oauth/google/start: read API key from header OR ?key=; constant-time
   compare; require KIZUNA_OAUTH_ENCRYPTION_KEY; mint signed CSRF state;
   302 to client.generateAuthUrl({ access_type: "offline", prompt:
   "consent", scope: gmail.readonly + calendar.readonly }).
       │
2. Browser → Google → /oauth/google/callback?code=…&state=….
       │
3. verifyState(KIZUNA_API_KEY, state) — HMAC + 10-min TTL; reject 401.
       │
4. client.getToken(code) → { refresh_token, scope, expiry_date, … }.
       │
5. encrypt(refresh_token, KIZUNA_OAUTH_ENCRYPTION_KEY) → AES-256-GCM
   envelope. OAuthToken.findOneAndUpdate({ provider:'google' }, …,
   { upsert: true }).
       │
6. SyncState.updateMany({ pausedAt: { $ne: null } }, { pausedAt: null,
   lastError: null }) — re-grant unpauses any worker stalled on
   invalid_grant. clearAccessTokenCache().
       │
7. 200 text/html "Granted ✓".
```

### Gmail sync tick (`POST /v1/sync/gmail/run` or scheduler)

```
1. loadOrInitState() — upsert SyncState{ provider:'gmail' }.
       │
2. If pausedAt is set and force !== true → return { status: 'paused' }.
       │
3. getAccessToken(config) — cached if not expired-30s, else decrypt
   refresh, exchange for access. invalid_grant → OAuthError → pauseWith.
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
3. `connectDb(MONGO_URI)` — `mongoose.connect` (5 s server-selection timeout) + `mongoose.syncIndexes()` for every registered model. Returns a `DbHandle` exposing `ping()` and `close()`.
4. `createApp({ db, config })` — builds the Express app: disables `x-powered-by`, mounts `express.json({ limit: '1mb' })`, then `health` (unauthed), `/oauth/*` (handler-level auth), `/v1/*` (`bearerAuth` middleware) for the rest of the routers, a 404 handler, and finally `makeErrorHandler()`.
5. `app.listen(config.PORT, …)` — `PORT` is `3000` by default; Portless overrides this when run as `portless run tsx watch src/main.ts`.
6. `startIngestScheduler({ config })` — `setInterval` every `KIZUNA_INGEST_INTERVAL_SEC` seconds (no startup tick — first run is one interval after boot, to avoid surprise sync runs on `tsx watch` reloads). When the env var is `0`, the scheduler is a no-op and ingest runs only via `POST /v1/sync/{gmail,gcal}/run`.
7. SIGINT / SIGTERM → stop scheduler → `server.close()` → `db.close()` → `process.exit(0)`. There is no app-level `SIGINT` handler for in-flight requests — Express's default is to stop accepting and let the active ones drain.

## Key Design Decisions

- **Hand-rolled Google clients.** `googleapis` would be the natural fit but pulls a heavy GAX runtime. `apps/api/src/ingest/{gmail,calendar}-client.ts` are thin `fetch` wrappers (≈70 lines each) that take an injected `getAccessToken` so the workers can be unit-tested with a fake. The `google-auth-library` dep is still used for the OAuth token exchange + refresh dance.
- **One write path for interactions.** `db/recordInteraction.ts` is the only module that inserts into `interactions`. It updates `Person.lastInteractionAt` via `$max` for every linked participant in the same call so the read-side denormalization is always consistent. Two paths exist on top: `recordInteraction` (insert; rejects duplicates if `skipIfDuplicate` is set, returning `null`) and `upsertInteractionBySourceRef` (upsert; replaces title/time/location/participants wholesale; cancelled events skip the `lastInteractionAt` bump).
- **Soft delete + tombstone semantics.** DELETE handlers `findOneAndUpdate` with `{ deletedAt: new Date() }`. Person tombstones additionally set `suppressReingest: true` so a future Gmail/Calendar sync won't recreate the row through `upsertPerson`. The `?includeTombstoned=true` flag on list endpoints surfaces them — the dashboard's `/tombstones` page is built on this.
- **Dedup by `sourceRef`.** `Interaction.sourceRef = { provider, id }` carries Gmail's message ID or Calendar's event ID. A unique partial index `(sourceRef.provider, sourceRef.id)` enforces "one interaction per Gmail message" and "one per Calendar event"; ingest workers replay safely. Concierge-created interactions have `sourceRef: null` and are exempt.
- **Skip-self on group threads.** When ≥ 2 non-user recipients remain, USER_EMAILS addresses are dropped from `to/cc` so the dashboard's relationship graph doesn't bloat with self-edges. The `from` role is preserved either way, which is what makes the dashboard's "outbound" badge work.
- **AES-256-GCM at rest, signed CSRF in flight.** Refresh tokens are encrypted with `KIZUNA_OAUTH_ENCRYPTION_KEY` (a base64 32-byte key, generated via `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`); IV is random per write, auth tag concatenated, base64 envelope. The OAuth callback can't carry the API key as a query param without leaking it through Google's redirect log, so it's protected instead by an HMAC-signed state token (`apps/api/src/lib/oauth-state.ts`, 10-min TTL, secret = `KIZUNA_API_KEY`).
- **In-process scheduler, no queue.** Ingest is a setInterval loop with a re-entrancy guard. Tradeoff: simpler ops, no external broker, no horizontal scale; for a single-user CRM this is fine. The manual triggers (`POST /v1/sync/{gmail,gcal}/run`) work regardless of the scheduler.
- **Two layers of contract enforcement.** Zod-strict request bodies (`.strict()`) reject unknown fields at the route boundary; Mongoose `strict: 'throw'` rejects them at the model boundary. Both surface as `400 bad_request`. Belt and suspenders, on the theory that a CRM's data quality is the product.
- **Cursor pagination, base64url JSON.** `apps/api/src/lib/cursor.ts`. Most cursors are `{ id }` (descending `_id`); the people list under `sort=lastInteractionAt:-1` uses a compound `{ lia, id }` cursor with a trailing-null bucket so people who've never had an interaction sort last but stay paginable.
- **Pull-only by design (system level).** Kizuna exposes an API; it never initiates outbound calls to sibling services in the Kagami workspace. Its only outbound network calls are to Google.

## Module Map

| Directory                              | Purpose                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/db/models/`              | Mongoose schemas (Person, Organization, Interaction, Followup, OAuthToken, SyncState) + `base.ts` provenance fields. See [data-model.md](data-model.md).                                                   |
| `apps/api/src/db/recordInteraction.ts` | The only insert path for `interactions`; maintains `Person.lastInteractionAt`.                                                                                                                             |
| `apps/api/src/ingest/`                 | Gmail + Calendar workers (state machines, paging, error mapping), pure parsers, `upsertPerson`, in-process scheduler. See [sync.md](sync.md).                                                              |
| `apps/api/src/routes/`                 | One Express router per resource. Each exports both the router and an `EndpointSpec[]` so the manifest stays in sync.                                                                                       |
| `apps/api/src/lib/`                    | Cross-cutting helpers — auth middleware, error envelope, AES-256-GCM, signed CSRF state, OAuth client + cached access token, base64url cursor, ISO duration parser, mongo→wire serializer, pino singleton. |
| `apps/api/src/manifest.ts`             | `zodToJsonSchema` factory used by `routes/manifest.ts` to render `GET /v1/_manifest` (OpenAPI-shaped endpoint catalog).                                                                                    |
| `apps/dashboard/src/app/`                  | Next.js 15 App Router. `(app)` route group is auth-gated; `(auth)` holds `/login`. See [dashboard.md](dashboard.md).                                                                                       |
| `apps/dashboard/src/lib/`                  | Typed API client, hand-mirrored response types, HMAC session cookie, formatters.                                                                                                                           |

## Cross-cutting Concerns

- **Logging.** `apps/api/src/lib/logger.ts` exports a pino logger (`base: { service: 'kizuna-api' }`). Pretty transport when `NODE_ENV=development`. Used directly in workers / boot / errors; there's no request-scoped logger middleware today.
- **Error handling.** `apps/api/src/lib/errors.ts` defines a `HttpError` class and an `errors.{badRequest,unauthorized,notFound,conflict,rateLimited,internal}` factory. The Express error handler maps `HttpError` → tagged 4xx, `ZodError` → `400 bad_request`, Mongoose `ValidationError` / `CastError` / `StrictModeError` → `400 bad_request`, code-11000 dup-key → `409 conflict`, everything else → `500 internal`.
- **Time handling.** All dates are stored as `Date` and serialized as ISO 8601. The dashboard formats in `America/New_York` (`apps/dashboard/src/lib/format.ts`) — hardcoded for now.
- **Reentrancy on ingest.** The scheduler keeps a `running = true` flag while a tick is in flight; overlapping ticks are skipped with a `logger.warn`. Manual `POST /sync/.../run` calls bypass this — they're synchronous round-trips driven by the caller.
- **Access-token caching.** `apps/api/src/lib/google-auth.ts` caches the Google access token in module scope, refreshed when `expiresAt < now + 30 s`. `clearAccessTokenCache()` is called from the OAuth callback so a re-grant invalidates immediately. The cache is process-local; in a multi-instance deploy each worker would keep its own copy (no shared cache today).
