# API

One surface: REST at `https://api.kizuna.localhost` (Portless). All `/v1/*` routes are bearer-gated; `/oauth/*` does its own per-handler auth (header OR `?key=`, callback uses HMAC-signed CSRF state); `/health` is open.

## Mount order

`apps/api/src/server.ts`:

```ts
app.use(express.json({ limit: '1mb' }));
app.use(healthRouter(db));            // GET /health        (no auth)
app.use('/oauth', makeOauthRouter(config));  // /oauth/google/{start,callback,status}
app.use('/v1', bearerAuth(config.KIZUNA_API_KEY));  // gates everything below
app.use('/v1', manifestRouter);
app.use('/v1', peopleRouter);
app.use('/v1', organizationsRouter);
app.use('/v1', interactionsRouter);
app.use('/v1', followupsRouter);
app.use('/v1', contextsRouter);
app.use('/v1', digestRouter);
app.use('/v1', makeSyncRouter(config));
app.use(...);                         // 404 fallthrough
app.use(makeErrorHandler());          // ZodError / HttpError / mongoose / E11000
```

## Conventions

- All request bodies, query strings, and path params parsed via zod. `.strict()` on every body schema rejects unknown fields with `400 bad_request`.
- All Mongoose schemas use `strict: 'throw'`, so unknown fields that survive zod still fail at insert time and become `400 bad_request`.
- Soft-delete by default. List endpoints filter `deletedAt: null` unless `?includeTombstoned=true`. DELETE handlers never `deleteOne`; they `findOneAndUpdate({ deletedAt: new Date() })`.
- Cursor pagination is base64url-encoded JSON. Cursor shapes are endpoint-specific (`{ id }` for the simple case, `{ lia, id }` for the people list under `lastInteractionAt:-1`).
- Auth: `Authorization: Bearer <KIZUNA_API_KEY>` for all `/v1/*`. Constant-time compare (`crypto.timingSafeEqual`).
- Error envelope: `{ error: { code, message, details? } }` with codes `bad_request | unauthorized | not_found | conflict | rate_limited | internal`.

## Auth

| Layer                    | Mechanism                                                                                   | File                              |
| ------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------- |
| `/v1/*`                  | `Authorization: Bearer <KIZUNA_API_KEY>`; constant-time compare                             | `apps/api/src/lib/auth.ts`        |
| `/oauth/google/start`    | Bearer header OR `?key=<KIZUNA_API_KEY>` (so a plain `<a href>` from the dashboard works)   | `apps/api/src/routes/oauth.ts`    |
| `/oauth/google/callback` | HMAC-signed state token (10-min TTL, secret = `KIZUNA_API_KEY`); no API key in the redirect | `apps/api/src/lib/oauth-state.ts` |
| `/oauth/google/status`   | Bearer header OR `?key=`                                                                    | `apps/api/src/routes/oauth.ts`    |
| Dashboard sessions       | HMAC-signed cookie, secret = `KIZUNA_API_KEY`, 30-day TTL                                   | `apps/dashboard/lib/session.ts`   |

See [auth.md](auth.md) for the full model.

## Endpoint reference

### People (`apps/api/src/routes/people.ts`)

| Method | Path                          | Body / Query                                                                                                             | Response                                                          |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| GET    | `/v1/people`                  | `?limit&cursor&query&orgId&tag&lastInteractionBefore&lastInteractionAfter&hasOpenFollowup&source&includeTombstoned&sort` | `{ items: Person[], nextCursor? }`                                |
| GET    | `/v1/people/:id`              | —                                                                                                                        | `Person`                                                          |
| POST   | `/v1/people`                  | `PersonCreateBody`                                                                                                       | `201 Person` (with `firstSeen` set to now, `source: 'concierge'`) |
| PATCH  | `/v1/people/:id`              | `PersonUpdateBody` (all `PersonCreateBody` fields, partial)                                                              | `Person`                                                          |
| DELETE | `/v1/people/:id`              | —                                                                                                                        | `Person` with `deletedAt` set, `suppressReingest: true`           |
| GET    | `/v1/people/:id/interactions` | (same query as `/v1/interactions`, with `personId` pinned)                                                               | `{ items: Interaction[], nextCursor? }`                           |

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

### Interactions (`apps/api/src/routes/interactions.ts`)

| Method | Path                   | Body / Query                                                                                                      | Response                                |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| GET    | `/v1/interactions`     | `?limit&cursor&personId&orgId&context&channel&occurredBefore&occurredAfter&query&status&source&includeTombstoned` | `{ items: Interaction[], nextCursor? }` |
| POST   | `/v1/interactions`     | `InteractionCreateBody`                                                                                           | `201 Interaction` (concierge-sourced)   |
| DELETE | `/v1/interactions/:id` | —                                                                                                                 | `Interaction` with `deletedAt` set      |

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

| Method | Path                | Body / Query                                                                   | Response                             |
| ------ | ------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| GET    | `/v1/followups`     | `?limit&cursor&personId&direction&status&dueBefore&dueAfter&includeTombstoned` | `{ items: Followup[], nextCursor? }` |
| POST   | `/v1/followups`     | `FollowupCreateBody`                                                           | `201 Followup`                       |
| PATCH  | `/v1/followups/:id` | `FollowupUpdateBody` — `{ status, dueAt?, reason? }` (status is required)      | `Followup`                           |
| DELETE | `/v1/followups/:id` | —                                                                              | `Followup` with `deletedAt` set      |

`status` defaults to `open` on the list endpoint. `direction` is `'i_owe' | 'they_owe'`; `status` is `'open' | 'done' | 'snoozed' | 'dismissed'`.

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

| Method | Path                    | Body / Query                                          | Response                                 |
| ------ | ----------------------- | ----------------------------------------------------- | ---------------------------------------- |
| GET    | `/v1/organizations`     | `?limit&cursor&query&domain&source&includeTombstoned` | `{ items: Organization[], nextCursor? }` |
| GET    | `/v1/organizations/:id` | —                                                     | `Organization`                           |
| POST   | `/v1/organizations`     | `OrganizationCreateBody`                              | `201 Organization`                       |
| PATCH  | `/v1/organizations/:id` | `OrganizationUpdateBody` (partial)                    | `Organization`                           |
| DELETE | `/v1/organizations/:id` | —                                                     | `Organization` with `deletedAt` set      |

`?query=…` is a case-insensitive regex match on `name` (regex chars escaped). `domain` filter is exact (lowercased).

### Contexts (`apps/api/src/routes/contexts.ts`)

| Method | Path           | Query                                     | Response                                           |
| ------ | -------------- | ----------------------------------------- | -------------------------------------------------- |
| GET    | `/v1/contexts` | `?personId&limit` (max 1000, default 200) | `{ items: Array<{ tag: string, count: number }> }` |

Aggregation: `$match { deletedAt: null, status: 'active', context: { $exists, $ne: [] } }` → `$unwind '$context'` → `$group _id: '$context', count: $sum 1` → `$sort { count: -1, _id: 1 }`.

### Digest (`apps/api/src/routes/digest.ts`)

| Method | Path         | Query                                                        | Response                                                             |
| ------ | ------------ | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| GET    | `/v1/digest` | `?window=P7D` (ISO duration; also accepts `7d`, `12h`, `2w`) | `{ window, generatedAt, windowStart, windowEnd, overdue, upcoming }` |

`overdue` = open followups with `dueAt < now`, sorted `dueAt asc`. `upcoming` = open followups with `now <= dueAt <= now + window`, same sort. Each followup is hydrated with `{ person: { id, displayName, primaryEmail } | null }`.

The duration parser (`apps/api/src/lib/duration.ts`) supports a subset of ISO 8601: weeks (`P2W`), days (`P7D`), hours (`PT12H`), and combinations (`P1DT12H`). Short forms `7d`, `12h`, `2w` are normalized to ISO before parsing.

### Sync (`apps/api/src/routes/sync.ts`)

| Method | Path                   | Body / Query          | Response                                                  |
| ------ | ---------------------- | --------------------- | --------------------------------------------------------- |
| GET    | `/v1/sync/gmail/state` | —                     | `SyncState` (or zero-default object if no row exists yet) |
| POST   | `/v1/sync/gmail/run`   | `{ force?: boolean }` | `RunSyncResult`                                           |
| GET    | `/v1/sync/gcal/state`  | —                     | `SyncState`                                               |
| POST   | `/v1/sync/gcal/run`    | `{ force?: boolean }` | `RunCalendarSyncResult`                                   |

`SyncState` shape: `{ provider, historyId, syncToken, lastRunAt, errorCount, lastError, pausedAt }`.

`RunSyncResult` (Gmail): `{ status: 'ok' | 'paused' | 'no_grant' | 'error', fetched, inserted, skippedExisting, skippedNewsletter, errors, historyIdAfter, message? }`.

`RunCalendarSyncResult` (Calendar): `{ status, fetched, upserted, cancelled, errors, syncTokenAfter, resyncedFromBootstrap, message? }`.

`force: true` clears `pausedAt` if the worker is currently paused (`invalid_grant`) and runs again. See [sync.md](sync.md).

### OAuth (`apps/api/src/routes/oauth.ts`)

| Method | Path                     | Auth                     | Behavior                                                                                                                                                                                             |
| ------ | ------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/oauth/google/start`    | Bearer header OR `?key=` | 302 to Google with `access_type=offline`, `prompt=consent`, `scope=gmail.readonly+calendar.readonly`, `state` = signed CSRF token                                                                    |
| GET    | `/oauth/google/callback` | Signed state token       | Exchanges code, encrypts refresh token with `KIZUNA_OAUTH_ENCRYPTION_KEY`, upserts `OAuthToken{ provider:'google' }`, unpauses workers, clears access-token cache, returns 200 text/html "Granted ✓" |
| GET    | `/oauth/google/status`   | Bearer header OR `?key=` | `{ granted: false }` or `{ granted: true, scopes: string[], grantedAt: ISODateString }`                                                                                                              |

Scopes (constant in `apps/api/src/lib/google-auth.ts`):

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar.readonly
```

### Manifest (`apps/api/src/routes/manifest.ts`)

| Method | Path            | Response                                                                        |
| ------ | --------------- | ------------------------------------------------------------------------------- |
| GET    | `/v1/_manifest` | `{ version: 'v1', endpoints: ManifestEndpoint[] }` — JSON-Schema-shaped catalog |

`ManifestEndpoint` carries `{ name, method, path, description, params?, query?, body?, response? }` where each schema is the output of `zodToJsonSchema(s, { target: 'jsonSchema7', name })`. Each route module exports its own `EndpointSpec[]`; `routes/manifest.ts` concatenates them and runs `buildManifest()` once at startup. This is the cheapest path to keep an OpenAPI-shaped catalog in lockstep with the zod schemas the routes already use.

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
| `unauthorized` | Missing or invalid bearer; OAuth state mismatch                                                  |
| `not_found`    | 404s from `errors.notFound(...)` and the catch-all 404 middleware                                |
| `conflict`     | E11000 duplicate-key (e.g. `Organization.domain` unique, `Interaction.sourceRef` unique partial) |
| `rate_limited` | Reserved; not currently raised from any code path                                                |
| `internal`     | Anything else; logged via `logger.error({ err })`                                                |

## Inter-service config

| Caller                   | Env var          | Default                        |
| ------------------------ | ---------------- | ------------------------------ |
| Kizuna dashboard         | `KIZUNA_API_URL` | `https://api.kizuna.localhost` |
| Standalone (no Portless) | —                | `http://localhost:3000`        |

The numeric standalone-fallback port (`3000`) only applies when running the API outside Portless; under `npm run dev`, Portless picks an ephemeral port and routes `https://api.kizuna.localhost` to it.
