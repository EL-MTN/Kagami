# Kizuna — Personal CRM Backend

A personal CRM backend whose only client is your AI concierge. No human-driven CRUD app to maintain; the concierge logs, queries, and reasons over the data on your behalf.

The concierge is **Mashiro** (`../Mashiro/`), running as a standalone instance. Kizuna is a deterministic store-and-query backend Mashiro talks to over a typed REST API — the two repos evolve together but ship separately. **Kizuna itself contains no LLM calls** — every code path it runs is a deterministic query, upsert, or sync. The intelligence lives entirely in Mashiro; Kizuna just gives it a structured world to look at.

## Principles

- **Fully deterministic.** Kizuna contains no LLM calls anywhere — not on the request path, not in ingest, not in workers. Every behavior is reproducible from the same inputs. All "intelligence" (summarization, followup extraction, semantic recall) is Mashiro's job; Kizuna just stores and queries.
- **AI-served, not AI-powered.** Mashiro is the only programmatic client. Kizuna exposes a typed REST API and a read-only Next.js dashboard — that's the entire surface area. (MCP could be layered on later if a second LLM client appears, but with one client we control end-to-end, REST is simpler and more debuggable.)
- **Read-only for humans.** The dashboard is for trust/sanity-checking. Edits go through Mashiro.
- **Local-first, portable.** Runs on your laptop in dev; same binary runs on a VPS later. No cloud-only dependencies and no third-party API providers in the runtime path.
- **Reactive core.** Kizuna never decides on its own when to act — it answers, stores, and reports. Proactive behavior lives in Mashiro.
- **Typed schemas everywhere.** Every field a writer sets is declared in a Mongoose schema with `strict: true`. We use Mongo for the document shape (embedded participants, arrays, nested objects), not for an "anything goes" hedge. New fields are additive schema changes, not ad-hoc keys — typos in concierge writes should fail loudly, not silently persist.

## Stack

- **Runtime:** Node.js (LTS, ESM)
- **HTTP:** Express 5
- **DB:** MongoDB (local `mongod` in dev; Atlas or self-hosted replica set in prod). ODM: Mongoose — schema discipline at the boundary, plus easy index declarations and lifecycle hooks. All collections use `strict: true`; unknown fields on writes are rejected, not silently persisted.
- **API:** Typed REST under `/v1/*`, JSON request/response, Zod schemas at every boundary (one schema per endpoint, shared between handler validation and response typing). The same schemas serve as the tool manifest Mashiro consumes.
- **Auth:** static API key in `Authorization: Bearer <key>` header. The dashboard browser session uses a separate cookie-based session (logged in via the same key once, then forgotten on the user's machine).
- **Frontend:** Next.js (App Router), separate process, talks to Kizuna's REST API. Server components for pages, no client-side state library — Mongo + REST is fast enough and the dashboard is read-only.
- **External APIs:** Google OAuth 2.0 for Gmail and Calendar.
- **Testing:** Vitest for unit tests; integration tests against a Mongo testcontainer; ingest tested with checked-in Gmail/Calendar API fixture payloads.

## Configuration

All config lives in `.env` (loaded via `dotenv`). Schema validated at boot with Zod — Kizuna refuses to start if a required key is missing or malformed.

| key | required | notes |
|---|---|---|
| `KIZUNA_API_KEY` | yes | static bearer token; rotate by changing this and the value in Mashiro/dashboard |
| `MONGO_URI` | yes | e.g. `mongodb://127.0.0.1:27017/kizuna` |
| `USER_EMAILS` | yes | comma-separated list of *your* email addresses (lowercased). Used to label outbound vs inbound interactions in the dashboard, skip self as a participant on group emails, and filter "from-me" rows in queries. |
| `GOOGLE_OAUTH_CLIENT_ID` | for ingest | from Google Cloud Console |
| `GOOGLE_OAUTH_CLIENT_SECRET` | for ingest | |
| `GOOGLE_OAUTH_REDIRECT_URI` | for ingest | e.g. `http://localhost:3000/oauth/google/callback` |
| `NEWSLETTER_DOMAIN_BLOCKLIST` | no | comma-separated; ingest skips senders matching these |
| `PORT` | no | default 3000 |
| `LOG_LEVEL` | no | default `info` |

## Data Model

All collections have a strict Mongoose schema. The Mongo document model buys us natural shapes (embedded participants, arrays, nested handles) without a separate `data` blob; it does not buy us — and we don't want — undeclared fields appearing in production data.

### Provenance & lifecycle (all collections)
Every document carries:
| field | type | notes |
|---|---|---|
| createdAt | Date | |
| updatedAt | Date | Mongoose timestamps |
| source | string | `concierge`, `gmail-sync`, `gcal-sync`, `manual`, `import` — who/what wrote it |
| sourceVersion | string | optional, for ingest workers (e.g. commit sha) |
| deletedAt | Date | tombstone — null/absent for live records, set when "deleted" |

**Soft delete only.** Concierge "delete" requests set `deletedAt`; nothing is actually removed. All read paths (typed tools, dashboard) filter out tombstoned rows by default. Provenance is non-optional — when the concierge mutates data we need to answer "who wrote this row" when debugging.

**Tombstones block re-ingest, but keep the link.** People carry an additional `suppressReingest: boolean` flag, defaulted true when tombstoned via the concierge. Gmail/Calendar ingest workers MUST check this before upserting by email/sourceRef:
- `suppressReingest = true` → do **not** mutate the person record (no clearing `deletedAt`, no field updates), but **do** keep the participant link on the new interaction pointing at the tombstoned `personId`. Default read paths filter out tombstoned people, so they vanish from the UI and from typed-tool results — but the link is there for "show me everything I tombstoned" queries and prevents orphaned interactions floating in search.
- `suppressReingest = false` (rare; e.g. after a manual "undelete") → normal upsert, which clears `deletedAt`.

Without this, every Gmail sync would resurrect anyone the concierge just tombstoned. Interactions and followups are tombstoned-and-done — they have no re-ingest path because `sourceRef` is unique and ingest skips existing rows regardless of `deletedAt`.

### Time
Single timezone: **America/New_York (EST/EDT)**. All `Date` fields are stored UTC; all human-facing display, parsing, and date-bucketing (digests, "today," birthday reminders, due-date arithmetic) happens in EST. No multi-tz handling — if that ever changes it's a real migration, not a config flag.

### `people` collection
| field | type | notes |
|---|---|---|
| _id | ObjectId | PK |
| displayName | string | |
| primaryEmail | string | indexed, nullable, lowercased |
| primaryOrgId | ObjectId | ref → organizations, nullable |
| relationship | string | freeform: friend, colleague, etc. |
| firstSeen | Date | |
| lastInteractionAt | Date | denormalized for sorting |
| emails | string[] | all known addresses |
| phones | string[] | |
| handles | object | `{ twitter, linkedin, github, … }` |
| tags | string[] | |
| birthday | string | ISO date or `--MM-DD` |
| notes | string | freeform |

### `organizations` collection
| field | type | notes |
|---|---|---|
| _id | ObjectId | PK |
| name | string | |
| domain | string | inferred from email; used for auto-linking; unique sparse index |
| website | string | |
| industry | string | |
| notes | string | |

### `interactions` collection
| field | type | notes |
|---|---|---|
| _id | ObjectId | PK |
| occurredAt | Date | |
| channel | string | email, calendar, in_person, call, message, manual |
| title | string | Deterministic short label: email subject, calendar event title, or first line of body for manual entries. Set by ingest/writer, never inferred. Text-indexed. |
| body | string | full email/event body, stored verbatim; text-indexed |
| sourceRef | object | `{ provider: 'gmail'\|'gcal', id: '...' }`; unique compound index |
| participants | array | `[{ personId, role: 'from'\|'to'\|'cc'\|'attendee'\|'subject' }]` |
| location | string | calendar events |
| attachments | array | `[{ name, mimeType, size, ref }]` |
| context | string[] | freeform context tags — e.g. `"conf:strangeloop-2025"`, `"project:acme-redesign"`, `"trip:tokyo-jan26"`. Lets the concierge group cross-channel interactions that share a real-world context (a conference, a project, a trip) without forcing every attendee to be tagged on the person. |
| status | string | `active` \| `cancelled` — for calendar events that get cancelled after ingest. Filtered out of timelines by default. |

Embedding `participants` inside the interaction (instead of a join collection) is the idiomatic Mongo move and keeps the read path to a single document.

**`lastInteractionAt` maintenance.** Every code path that inserts an interaction (ingest workers, `log_interaction`, manual scripts) is responsible for `$max`-updating `lastInteractionAt` on each linked person in the same Mongoose lifecycle hook. Centralized in a single `recordInteraction(interaction)` helper to keep this invariant — no other write path is allowed to insert into `interactions` directly.

### `followups` collection
| field | type | notes |
|---|---|---|
| _id | ObjectId | PK |
| personId | ObjectId | ref → people |
| direction | string | `i_owe` \| `they_owe` — who's on the hook. Set by Mashiro at `create_followup` time, since it has the conversational context to know. Lets `list_followups({ direction: 'i_owe' })` answer "what did I tell Sarah I'd send her?" without scanning reasons. |
| dueAt | Date | |
| status | string | open, done, snoozed, dismissed |
| reason | string | "you said you'd send the deck" |
| sourceInteractionId | ObjectId | nullable |

### `sync_state` collection
One document per provider (`gmail`, `gcal`) holding `historyId` / `syncToken`, last run, error counts.

### Indexes
- `people`: `{ primaryEmail: 1 }`, `{ lastInteractionAt: -1 }`, text index on `displayName + notes + tags`
- `organizations`: `{ domain: 1 }` unique sparse
- `interactions`: `{ occurredAt: -1 }`, `{ 'participants.personId': 1, occurredAt: -1 }`, `{ 'sourceRef.provider': 1, 'sourceRef.id': 1 }` unique, `{ context: 1, occurredAt: -1 }`, text index on `title + body`
- `followups`: `{ status: 1, dueAt: 1 }`, `{ personId: 1, direction: 1, status: 1 }`
- All collections: partial index on `{ deletedAt: 1 }` so live-row filters stay cheap.

## Surfaces

### 1. REST API (primary)
All endpoints live under `/v1/*`, JSON in/out, bearer auth. Every endpoint has a Zod schema for both request body and response shape; the same schemas serve as the tool manifest Mashiro consumes (it gets a `GET /v1/_manifest` that returns the JSON Schema for every operation). If a query Mashiro wants isn't expressible here, the answer is to extend the typed endpoints — not to add an LLM-on-request-path tool.

#### Read endpoints
- `GET /v1/people` — `find_people(filter)`
- `GET /v1/people/:id` — `get_person`
- `GET /v1/organizations` — `find_organizations(filter)`
- `GET /v1/organizations/:id`
- `GET /v1/interactions` — `list_interactions(filter)`
- `GET /v1/people/:id/interactions` — `get_interactions_for`
- `GET /v1/followups` — `list_followups(filter)`
- `GET /v1/digest?window=7d` — overdue + upcoming followups. `window` defaults to 7 days; accepts ISO 8601 durations (`P1D`, `P30D`).

#### Write endpoints
- `POST /v1/people` — `add_person`
- `PATCH /v1/people/:id` — `update_person`
- `DELETE /v1/people/:id` — tombstone (soft delete)
- `POST /v1/organizations` / `PATCH /v1/organizations/:id` / `DELETE /v1/organizations/:id`
- `POST /v1/interactions` — `log_interaction`
- `DELETE /v1/interactions/:id` — tombstone
- `POST /v1/followups` — `create_followup`
- `PATCH /v1/followups/:id` — `complete_followup` / status transitions
- `DELETE /v1/followups/:id` — tombstone

#### Filter DSL (read endpoints)
Every list endpoint takes a query-string filter object. Unknown keys are rejected by the Zod schema. All filters default to live rows (`deletedAt: null`) and active rows (`status: 'active'` where applicable); pass the `include*` flags below to expand. Pagination is cursor-based: pass `limit` (default 50, max 200) and `cursor` (opaque string from a prior response's `nextCursor`).

`GET /v1/people`:
- `query`: text-search string over `displayName + notes + tags`
- `orgId`: ObjectId — exact match on `primaryOrgId`
- `tag`: string (repeatable — multiple `tag` params AND together)
- `lastInteractionBefore`, `lastInteractionAfter`: ISO date
- `hasOpenFollowup`: boolean
- `source`: provenance string
- `includeTombstoned`: boolean (default false)

`GET /v1/interactions`:
- `personId`: ObjectId — convenience for `participants.personId`
- `orgId`: ObjectId — joins through participant people
- `context`: string — exact match against any element of `context[]`
- `channel`: string
- `occurredBefore`, `occurredAfter`: ISO date
- `query`: text-search string over `title + body`
- `status`: `'active' | 'cancelled' | 'any'` (default `'active'`)
- `source`: provenance string
- `includeTombstoned`: boolean (default false)

`GET /v1/followups`:
- `personId`: ObjectId
- `direction`: `'i_owe' | 'they_owe'`
- `status`: one of open/done/snoozed/dismissed (default `'open'`)
- `dueBefore`, `dueAfter`: ISO date
- `includeTombstoned`: boolean (default false)

#### Write payload shapes
Required fields are bold; everything else is optional. Provenance fields (`source`, `sourceVersion`) are set automatically from the auth context (concierge requests get `source: 'concierge'`, ingest workers set their own).

`POST /v1/people`:
- **`displayName`**: string
- `primaryEmail`: string (lowercased before insert)
- `primaryOrgId`: ObjectId
- `relationship`: string
- `emails`, `phones`, `tags`: string[]
- `handles`: object
- `birthday`: ISO date or `--MM-DD`
- `notes`: string

`PATCH /v1/people/:id`: partial of the above. `emails`/`phones`/`tags`/`handles` replace; use array semantics on the client side. `firstSeen` and `lastInteractionAt` are not settable (managed by the system).

`POST /v1/interactions`:
- **`occurredAt`**: ISO date
- **`channel`**: one of `email | calendar | in_person | call | message | manual`
- **`title`**: string
- **`body`**: string
- **`participants`**: array of `{ personId, role }` — at least one entry; role is one of `from | to | cc | attendee | subject`
- `context`: string[]
- `location`: string
- `attachments`: array
- `sourceRef`: object — only set by ingest workers; concierge writes leave this null

`POST /v1/followups`:
- **`personId`**: ObjectId
- **`direction`**: `'i_owe' | 'they_owe'`
- **`reason`**: string
- `dueAt`: ISO date
- `sourceInteractionId`: ObjectId

`PATCH /v1/followups/:id`:
- **`status`**: `'open' | 'done' | 'snoozed' | 'dismissed'`
- `dueAt`: ISO date (for snooze)
- `reason`: string

#### Errors
Standardized JSON: `{ error: { code, message, details? } }` with HTTP status codes for class (`400` validation, `401` auth, `404` not found, `409` conflict, `429` rate limit, `5xx` server). `details` is the Zod issues array on validation errors.

### 2. Ingest workers (background, in-process)
Two workers, both deterministic — no LLM calls:

- **Gmail sync** — incremental via History API. For each new message: filter automated mail (List-Unsubscribe header → skip; `NEWSLETTER_DOMAIN_BLOCKLIST` match → skip), upsert sender/recipients as people (respecting `suppressReingest`), store the message as an interaction with `title` set to the email's `Subject` header and `body` set to the plain-text part. Cursor advances as soon as the row commits.
- **Calendar sync** — incremental via sync tokens. Each event becomes an interaction (`channel: 'calendar'`, `title` from the event's title, `body` from the event description); attendees are joined to people. Re-ingest of an existing event upserts by `sourceRef`: title/time/location are overwritten; participants are reconciled (added/removed); cancelled events flip `status: 'cancelled'` rather than tombstoning, so the audit trail survives.

#### Google OAuth
Both workers share a single OAuth identity (the user's Google account).

- **Scopes**: `gmail.readonly` + `calendar.readonly` — read-only is sufficient since Kizuna never writes back to Google.
- **Initial grant**: `GET /oauth/google/start` redirects to Google's consent screen; `GET /oauth/google/callback` exchanges the code and stores the resulting refresh token in a new `oauth_tokens` collection (`{ provider: 'google', refreshToken, scopes, grantedAt }`). One-time human action; routes are gated by the same API key auth as everything else (no public OAuth flow).
- **Access tokens**: not stored. Refreshed on demand at the start of each sync run; cached in memory for the run's lifetime.
- **Revocation**: if a refresh fails with `invalid_grant`, the worker pauses itself and the dashboard's Sync status panel surfaces a re-grant link. No silent retries on auth failures.

**Followup creation is Mashiro's job.** Kizuna never extracts followups from interaction bodies. When Mashiro sees a commitment in conversation (or while reading an email through `get_interactions_for`), it calls `create_followup` directly with `direction`, `reason`, `dueAt`, and `sourceInteractionId` set. Direction is unambiguous because Mashiro is the one deciding.

**Idempotency & partial failure.** Both workers process records in batches and advance `sync_state.historyId` / `syncToken` only after each batch commits to Mongo. A crash mid-batch replays the same window on restart, and `sourceRef` uniqueness keeps replays safe. With no LLM in the loop, there's no provider outage to design around — only Gmail/Calendar API errors, which are retried with exponential backoff.

Both workers can be paused; both write to the `sync_state` collection so restarts are cheap.

### 3. Read-only dashboard (Next.js)
Separate Next.js app (`web/`), running on its own port. Server components fetch from Kizuna's REST API using the same bearer token. Routes:

- `/` — **Today**: followups due, recent interactions
- `/people` — searchable, sortable by `lastInteractionAt`; filterable by `source`, tag, org
- `/people/[id]` — timeline of interactions (filterable by date range, channel, source), open followups, raw JSON peek; outbound vs inbound distinguished using `USER_EMAILS`
- `/contexts` — index of every distinct `context` tag with counts; click-through shows interactions and implied participants
- `/sync` — last Gmail/Calendar pull, error counts, retry backoff state, re-grant link if OAuth has been revoked
- `/errors` — sync worker failures, unresolved participants, ingest rows with malformed fields. The "I caught a bad row, show me adjacent rows" surface
- `/tombstones` — tombstoned people / interactions / followups, so deletes are verifiable

No edit affordances. A "tell concierge to fix this" button can deep-link into Mashiro later.

Search is plain Mongo text search over `displayName + notes + tags + interactions.title + interactions.body`, exposed via the same REST endpoints (`?query=`). No LLM anywhere.

## Privacy & Security

- All bodies stored locally (Mongo data dir on your machine). No third-party telemetry. **No LLM calls leave Kizuna** — interaction bodies never reach an external model from this process. (Mashiro may read them via REST and send fragments to its own provider, but that's Mashiro's policy to set, not Kizuna's.)
- API key in `.env`, never logged. Generous per-minute rate limits on all routes as a runaway-loop circuit breaker, not normal-use throttling.
- OAuth refresh tokens encrypted at rest in `oauth_tokens` (envelope encryption with a key from `.env`); access tokens never persisted.
- Mongo bound to `127.0.0.1` in dev; require auth + TLS when moved to a VPS.
- Optional encryption-at-rest via MongoDB's WiredTiger encryption (Enterprise) or full-disk encryption on the host.

## Project Layout

```
kizuna/
  api/                   # Express + Mongoose + ingest workers (the backend service)
    src/
      server.ts          # Express app, mounts /v1/*, /oauth/*
      config.ts          # Zod-validated env loader
      db/
        connect.ts       # mongoose.connect + lifecycle
        models/          # Mongoose schemas: Person, Organization, Interaction, Followup, SyncState, OAuthToken
        recordInteraction.ts   # the only path that inserts into interactions; updates lastInteractionAt
      routes/
        people.ts        # /v1/people CRUD
        organizations.ts
        interactions.ts
        followups.ts
        digest.ts
        manifest.ts      # /v1/_manifest — Zod schemas exported as JSON Schema for Mashiro
        oauth.ts         # /oauth/google/{start,callback}
        health.ts
      ingest/
        gmail.ts         # deterministic sync; no LLM
        calendar.ts
        google-auth.ts   # token refresh, revocation handling
      lib/
        auth.ts          # bearer middleware
        errors.ts        # standardized error envelope
    test/
      fixtures/          # Gmail/Calendar payloads for integration tests
    package.json
  web/                   # Next.js dashboard (separate process)
    app/
      page.tsx           # /
      people/
      contexts/
      sync/
      errors/
      tombstones/
    lib/
      api.ts             # bearer-token REST client
    package.json
  scripts/
    import-vcards.ts     # one-off bulk imports
  .env.example
  package.json           # workspace root
```

## Build Order

1. **Skeleton + DB + config + auth.** Express server, Mongoose models with `syncIndexes()` on boot, Zod env validation, bearer middleware, error envelope. `GET /health` reports DB ping. Vitest + Mongo testcontainer wired up.
2. **REST CRUD with Zod schemas.** All read + write endpoints for people/orgs/interactions/followups, including filter DSL, tombstone semantics, `suppressReingest`, `recordInteraction` helper enforcing `lastInteractionAt`. `GET /v1/_manifest` exports JSON Schema. **Wire Mashiro to it end-to-end here** — proving the API shape before building anything else on top.
3. **Next.js dashboard.** Server components hitting the REST API. Forces you to look at the data; surfaces shape bugs early.
4. **Google OAuth.** `/oauth/google/{start,callback}` flow, encrypted refresh-token storage, in-memory access-token caching. No ingest yet — just proving the credential path works.
5. **Gmail ingest.** History-based, idempotent via `sourceRef`. Newsletter filter (List-Unsubscribe + `NEWSLETTER_DOMAIN_BLOCKLIST`) is a prereq inside this step. `title` from `Subject`, `body` from plain-text part. `recordInteraction` keeps `lastInteractionAt` correct.
6. **Calendar ingest.** Including the upsert/reconcile path for edited events and `status: 'cancelled'` for cancellations. `title` from event title, `body` from description.
7. **Digest endpoint.**

## Open Questions

- **Concierge identity.** Single API key for now. The `source` field on every document already captures who-wrote-what; a second token for ingest workers is a hardening step we can add later if logs need it.
- **Person merging.** Same human across two emails. Manual merge via concierge tool initially; revisit after a few weeks of real data.
- **Backups.** Nightly `mongodump` → encrypted archive somewhere off the machine. Decide where (Restic to S3, Backblaze, iCloud Drive).
