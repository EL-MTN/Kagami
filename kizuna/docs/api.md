# API

One surface: REST at `https://api.kizuna.localhost` (Portless). The API is open at single-user localhost — no bearer auth on resource routes. There is no OAuth surface on Kizuna anymore; Google access is vended on demand from the Kao identity service (see [auth.md](auth.md), [sync.md](sync.md)).

## Mount order

`apps/api/src/server.ts`:

```ts
app.use(express.json({ limit: '1mb' }));
app.use(healthRouter(db));            // GET /health
// no /oauth router — consent + grant status live in Kao
app.use('', peopleRouter);
app.use('', organizationsRouter);
app.use('', interactionsRouter);
app.use('', followupsRouter);
app.use('', contextsRouter);
app.use('', digestRouter);
app.use('', makeSyncRouter(config));
app.use(...);                         // 404 fallthrough
app.use(makeErrorHandler());          // ZodError / HttpError / mongoose / E11000
```

## Conventions

- All request bodies, query strings, and path params parsed via zod. `.strict()` on every body schema rejects unknown fields with `400 bad_request`.
- All Mongoose schemas use `strict: 'throw'`, so unknown fields that survive zod still fail at insert time and become `400 bad_request`.
- Soft-delete by default. List endpoints filter `deletedAt: null` unless `?includeTombstoned=true`. DELETE handlers never `deleteOne`; they `findOneAndUpdate({ deletedAt: new Date() })`.
- Cursor pagination is base64url-encoded JSON. Cursor shapes are endpoint-specific (`{ id }` for the simple case, `{ lia, id }` for the people list under `lastInteractionAt:-1`, `{ ib, lia, id }` for identity people search, `{ oa, id }` for interaction event-time sort, `{ dp, due, id }` for followup due-priority sort).
- No API auth. The OS user boundary is the trust boundary; the API binds to `127.0.0.1` via Portless. See [auth.md](auth.md) for threat-model details.
- Error envelope: `{ error: { code, message, details? } }` with codes `bad_request | unauthorized | not_found | conflict | rate_limited | internal`.

## Auth

| Layer                | Mechanism                                                                                              | File                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------- |
| resource routes      | none — open at localhost                                                                               | —                                |
| Google OAuth consent | delegated to the Kao identity service at `${KAO_URL}/oauth/kizuna/start`                               | (none in Kizuna)                 |
| Google access tokens | vended on demand from `${KAO_URL}/grants/kizuna/token` (bearer `KAO_TOKEN`); cached in-process for TTL | `apps/api/src/lib/kao-client.ts` |
| Dashboard sessions   | none — dashboard is open at localhost                                                                  | —                                |

See [auth.md](auth.md) for the full model.

## Endpoint reference

### People (`apps/api/src/routes/people.ts`)

| Method | Path                       | Body / Query                                                                                                                           | Response                                                          |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/people`                  | `?limit&cursor&query&identityQuery&orgId&tag&lastInteractionBefore&lastInteractionAfter&hasOpenFollowup&source&includeTombstoned&sort` | `{ items: Person[], nextCursor? }`                                |
| GET    | `/people/:id`              | —                                                                                                                                      | `Person`                                                          |
| POST   | `/people`                  | `PersonCreateBody`                                                                                                                     | `201 Person` (with `firstSeen` set to now, `source: 'concierge'`) |
| PATCH  | `/people/:id`              | `PersonUpdateBody` (all `PersonCreateBody` fields, partial)                                                                            | `Person`                                                          |
| DELETE | `/people/:id`              | —                                                                                                                                      | `Person` with `deletedAt` set, `suppressReingest: true`           |
| GET    | `/people/:id/interactions` | (same query as `/interactions`, with `personId` pinned)                                                                                | `{ items: Interaction[], nextCursor? }`                           |

`PersonCreateBody` (zod-strict):

```ts
{
  displayName: string;            // required, min length 1
  primaryEmail?: string;          // lowercased
  primaryOrgId?: string;          // 24-char hex ObjectId
  relationship?: string;
  emails?: string[];              // lowercased
  phones?: string[];
  handles?: Record<string, string>;
  tags?: string[];
  birthday?: string;              // "YYYY-MM-DD" or "--MM-DD"
  notes?: string;
}
```

`Person` response (`apps/api/src/lib/serialize.ts::serializePerson`):

```ts
{
  id: string;                     // hex ObjectId
  displayName: string;
  primaryEmail: string | null;
  primaryOrgId: string | null;
  relationship: string | null;
  firstSeen: ISODateString | null;
  lastInteractionAt: ISODateString | null;
  emails: string[];
  phones: string[];
  handles: Record<string, string>;  // Map serialized as plain object
  tags: string[];
  birthday: string | null;
  notes: string | null;
  suppressReingest: boolean;
  source: 'concierge' | 'gmail-sync' | 'gcal-sync' | 'manual' | 'import';
  sourceVersion: string | null;
  deletedAt: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}
```

The list filter `?hasOpenFollowup=true|false` runs a `Followup.distinct('personId', { status: 'open', deletedAt: null })` and applies it as `_id: { $in: openIds }` (or `$nin: openIds`).

The `?sort=lastInteractionAt:-1` mode uses a compound cursor (`{ lia, id }`) with a trailing-null bucket so people who've never had an interaction sort last but stay paginable. Default sort is `_id:-1` with a simple `{ id }` cursor.

`?identityQuery=...` is a relevance-ordered identity search for consumers like Kokoro. It matches stable identity fields (`displayName`, `primaryEmail`, `emails`, `handles`) but not broad notes or relationship text. It cannot be combined with `query`; combining both returns `400 bad_request`. Its cursor stores the last identity relevance bucket plus secondary sort keys (`{ ib, lia, id }`) so pagination remains deterministic.

### Interactions (`apps/api/src/routes/interactions.ts`)

| Method | Path                | Body / Query                                                                                                           | Response                                |
| ------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| GET    | `/interactions`     | `?limit&cursor&personId&orgId&context&channel&occurredBefore&occurredAfter&query&status&source&includeTombstoned&sort` | `{ items: Interaction[], nextCursor? }` |
| POST   | `/interactions`     | `InteractionCreateBody`                                                                                                | `201 Interaction` (concierge-sourced)   |
| DELETE | `/interactions/:id` | —                                                                                                                      | `Interaction` with `deletedAt` set      |

`InteractionCreateBody` (zod-strict):

```ts
{
  occurredAt: DateInput;          // ISO-parseable
  channel: 'email' | 'calendar' | 'in_person' | 'call' | 'message' | 'manual';
  title: string;                  // min length 1
  body?: string;
  participants: Array<{           // min 1
    personId: string;             // hex ObjectId
    role: 'from' | 'to' | 'cc' | 'attendee' | 'subject';
  }>;
  context?: string[];
  location?: string;
  attachments?: Array<{ name: string; mimeType?: string; size?: number; ref?: string }>;
}
```

The `status` query value `any` returns both `active` and `cancelled`. Default is `active`. `?orgId=<id>` runs a two-step join: `Person.distinct('_id', { primaryOrgId, deletedAt: null })` → `participants.personId: { $in: peopleIds }`. `?query=…` is a `$text` search over `title` + `body` (the `interactions_text` index).

`?sort=occurredAt:-1` uses a compound cursor (`{ oa, id }`) so event-time lists remain deterministic across ties. Default sort is `_id:-1` with a simple `{ id }` cursor.

POST goes through `db/recordInteraction.ts`, which also bumps `Person.lastInteractionAt` via `$max` for every linked participant in the same call. `source: 'concierge'` is set automatically.

`Interaction` response shape:

```ts
{
  id: string;
  occurredAt: ISODateString;
  channel: 'email' | 'calendar' | 'in_person' | 'call' | 'message' | 'manual';
  title: string;
  body: string;
  sourceRef: { provider: 'gmail' | 'gcal'; id: string } | null;
  participants: Array<{ personId: string; role: 'from' | 'to' | 'cc' | 'attendee' | 'subject' }>;
  location: string | null;
  attachments: Array<{ name: string; mimeType: string | null; size: number | null; ref: string | null }>;
  context: string[];
  status: 'active' | 'cancelled';
  source: 'concierge' | 'gmail-sync' | 'gcal-sync' | 'manual' | 'import';
  sourceVersion: string | null;
  deletedAt: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}
```

### Followups (`apps/api/src/routes/followups.ts`)

| Method | Path             | Body / Query                                                                        | Response                             |
| ------ | ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| GET    | `/followups`     | `?limit&cursor&personId&direction&status&dueBefore&dueAfter&includeTombstoned&sort` | `{ items: Followup[], nextCursor? }` |
| POST   | `/followups`     | `FollowupCreateBody`                                                                | `201 Followup`                       |
| PATCH  | `/followups/:id` | `FollowupUpdateBody` — `{ status, dueAt?, reason? }` (status is required)           | `Followup`                           |
| DELETE | `/followups/:id` | —                                                                                   | `Followup` with `deletedAt` set      |

`status` defaults to `open` on the list endpoint. `direction` is `'i_owe' | 'they_owe'`; `status` is `'open' | 'done' | 'snoozed' | 'dismissed'`.

`?sort=duePriority:1` orders dated followups first by `dueAt` ascending, then undated followups, with a compound cursor (`{ dp, due, id }`). The persisted `duePriorityBucket` field is maintained by the Followup model and exists only to make that sort indexable.

`FollowupCreateBody`:

```ts
{
  personId: string;               // hex ObjectId
  direction: 'i_owe' | 'they_owe';
  reason: string;                 // min length 1
  dueAt?: DateInput;
  sourceInteractionId?: string;
}
```

### Organizations (`apps/api/src/routes/organizations.ts`)

| Method | Path                 | Body / Query                                          | Response                                 |
| ------ | -------------------- | ----------------------------------------------------- | ---------------------------------------- |
| GET    | `/organizations`     | `?limit&cursor&query&domain&source&includeTombstoned` | `{ items: Organization[], nextCursor? }` |
| GET    | `/organizations/:id` | —                                                     | `Organization`                           |
| POST   | `/organizations`     | `OrganizationCreateBody`                              | `201 Organization`                       |
| PATCH  | `/organizations/:id` | `OrganizationUpdateBody` (partial)                    | `Organization`                           |
| DELETE | `/organizations/:id` | —                                                     | `Organization` with `deletedAt` set      |

`?query=…` is a case-insensitive regex match on `name` (regex chars escaped). `domain` filter is exact (lowercased).

### Contexts (`apps/api/src/routes/contexts.ts`)

| Method | Path        | Query                                     | Response                                           |
| ------ | ----------- | ----------------------------------------- | -------------------------------------------------- |
| GET    | `/contexts` | `?personId&limit` (max 1000, default 200) | `{ items: Array<{ tag: string, count: number }> }` |

Aggregation: `$match { deletedAt: null, status: 'active', context: { $exists, $ne: [] } }` → `$unwind '$context'` → `$group _id: '$context', count: $sum 1` → `$sort { count: -1, _id: 1 }`.

### Digest (`apps/api/src/routes/digest.ts`)

| Method | Path      | Query                                                        | Response                                                             |
| ------ | --------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| GET    | `/digest` | `?window=P7D` (ISO duration; also accepts `7d`, `12h`, `2w`) | `{ window, generatedAt, windowStart, windowEnd, overdue, upcoming }` |

`overdue` = open followups with `dueAt < now`, sorted `dueAt asc`. `upcoming` = open followups with `now <= dueAt <= now + window`, same sort. Each followup is hydrated with `{ person: { id, displayName, primaryEmail } | null }`.

The duration parser (`apps/api/src/lib/duration.ts`) supports a subset of ISO 8601: weeks (`P2W`), days (`P7D`), hours (`PT12H`), and combinations (`P1DT12H`). Short forms `7d`, `12h`, `2w` are normalized to ISO before parsing.

### Sync (`apps/api/src/routes/sync.ts`)

| Method | Path                | Body / Query          | Response                                                  |
| ------ | ------------------- | --------------------- | --------------------------------------------------------- |
| GET    | `/sync/gmail/state` | —                     | `SyncState` (or zero-default object if no row exists yet) |
| POST   | `/sync/gmail/run`   | `{ force?: boolean }` | `RunSyncResult`                                           |
| GET    | `/sync/gcal/state`  | —                     | `SyncState`                                               |
| POST   | `/sync/gcal/run`    | `{ force?: boolean }` | `RunCalendarSyncResult`                                   |

`SyncState` shape: `{ provider, historyId, syncToken, lastRunAt, errorCount, lastError, pausedAt }`.

`RunSyncResult` (Gmail): `{ status: 'ok' | 'paused' | 'no_grant' | 'error', fetched, inserted, skippedExisting, skippedNewsletter, errors, historyIdAfter, message? }`.

`RunCalendarSyncResult` (Calendar): `{ status, fetched, upserted, cancelled, errors, syncTokenAfter, resyncedFromBootstrap, message? }`.

`force: true` clears `pausedAt` if the worker is currently paused (`invalid_grant`) and runs again. See [sync.md](sync.md).

### OAuth (delegated to Kao)

Kizuna no longer hosts an OAuth surface. Consent for the `kizuna` grant (`gmail.readonly` + `calendar.readonly`) lives at `${KAO_URL}/oauth/kizuna/start`, owned by the Kao identity service. The Kizuna API simply vends access tokens via `GET ${KAO_URL}/grants/kizuna/token` (bearer `KAO_TOKEN`) when an ingest run needs one — see [`apps/api/src/lib/kao-client.ts`](../apps/api/src/lib/kao-client.ts), [auth.md](auth.md), and [sync.md](sync.md). The dashboard's `/sync` page links out to Kao for grant/re-grant.

### Health (`apps/api/src/routes/health.ts`)

| Method | Path      | Auth | Response                                                               |
| ------ | --------- | ---- | ---------------------------------------------------------------------- |
| GET    | `/health` | none | `{ ok, service: 'kizuna-api', db: 'up' \| 'down', time }` (200 or 503) |

`db` is determined by `mongoose.connection.db.admin().ping()`. Returns `503` only when the ping throws or returns non-`ok`.

## Error envelope

```json
{ "error": { "code": "bad_request", "message": "invalid input", "details": [...] } }
```

| Code           | When                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `bad_request`  | Zod parse failure, mongoose `ValidationError` / `CastError` / `StrictModeError`, custom 400s     |
| `unauthorized` | OAuth state mismatch                                                                             |
| `not_found`    | 404s from `errors.notFound(...)` and the catch-all 404 middleware                                |
| `conflict`     | E11000 duplicate-key (e.g. `Organization.domain` unique, `Interaction.sourceRef` unique partial) |
| `rate_limited` | Reserved; not currently raised from any code path                                                |
| `internal`     | Anything else; logged via `logger.error({ err })`                                                |

## Inter-service config

| Caller           | Env var          | Default                        |
| ---------------- | ---------------- | ------------------------------ |
| Kizuna dashboard | `KIZUNA_API_URL` | `https://api.kizuna.localhost` |
| Kokoro bot       | `KIZUNA_URL`     | `https://api.kizuna.localhost` |

Use the Portless URL whenever the API is launched by `npm run dev` / `portless run`. The numeric standalone-fallback port (`3000`) only applies when running the API directly outside Portless.
