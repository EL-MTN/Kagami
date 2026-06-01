# Data model

All persistent state lives in a single MongoDB database (Mongoose 8). Default URI is `mongodb://127.0.0.1:27017/kizuna`. There is no Atlas Search or vector index requirement — only btree + text indexes — so any vanilla MongoDB ≥ 6 works.

## Layout

```
apps/api/src/db/
├── connect.ts                 # mongoose.connect + syncIndexes + DbHandle
├── models/
│   ├── base.ts                # baseSchemaOptions + provenanceFields
│   ├── Person.ts
│   ├── Organization.ts
│   ├── Interaction.ts
│   ├── Followup.ts
│   ├── SyncState.ts           # per-provider sync cursor + pause state
│   └── index.ts               # registers every model so syncIndexes finds them
└── recordInteraction.ts       # the only insert path for `interactions`
```

Mongoose options shared by every schema (`base.ts`):

```ts
baseSchemaOptions = {
  timestamps: true, // createdAt / updatedAt
  strict: "throw", // unknown fields on write throw → 400 bad_request
  versionKey: false, // no __v
};

provenanceFields = {
  source: { type: String, required: true, enum: SOURCE_VALUES },
  sourceVersion: { type: String },
  deletedAt: { type: Date, default: null },
};
```

`SOURCE_VALUES = ['concierge', 'gmail-sync', 'gcal-sync', 'manual', 'import']`.

`connectDb` calls `mongoose.syncIndexes()` after connect, which forces index creation up-front instead of Mongoose's default background build — partial-unique constraints (notably `interactions.sourceRef`) need to be in place before the ingest scheduler can rely on them for dedup.

## Soft delete

DELETE handlers never remove rows; they `findOneAndUpdate({ deletedAt: new Date() })`. List endpoints filter `deletedAt: null` unless `?includeTombstoned=true`. Every model has a sparse `{ deletedAt: 1 }` index so the dashboard's `/tombstones` page can scan only the tombstoned rows efficiently.

The Person tombstone additionally sets `suppressReingest: true`, so the Gmail or Calendar sync won't recreate the row through `upsertPerson` when it next observes a matching email — see [sync.md](sync.md).

## Collections

### `people`

`apps/api/src/db/models/Person.ts`:

```ts
{
  _id:               ObjectId
  displayName:       string                // required
  primaryEmail:      string | null         // lowercased, trimmed
  primaryOrgId:      ObjectId | null       // ref: 'Organization'
  relationship:      string?               // free-form
  firstSeen:         Date?                 // set on creation, never updated
  lastInteractionAt: Date?                 // updated via $max on every recordInteraction call
  emails:            string[]              // additional addresses
  phones:            string[]
  handles:           Map<string, string>   // serialized as plain object on read
  tags:              string[]
  birthday:          string?               // 'YYYY-MM-DD' or '--MM-DD'
  notes:             string?
  suppressReingest:  boolean (default false) // set true by tombstone; ingest path respects this
  source:            'concierge' | 'gmail-sync' | 'gcal-sync' | 'manual' | 'import'
  sourceVersion:     string?
  deletedAt:         Date | null
  createdAt:         Date
  updatedAt:         Date
}
```

Indexes:

| Name                               | Key                                                    | Purpose                                                                        |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `primaryEmail_1`                   | `{ primaryEmail: 1 }` (sparse)                         | `upsertPerson` find-or-create lookup; sparse so `null` doesn't bloat the index |
| `displayName_1`                    | `{ displayName: 1 }`                                   | Identity search prefix/exact matching                                          |
| `emails_1`                         | `{ emails: 1 }`                                        | Identity search over alternate email addresses                                 |
| `people_handles_identity_wildcard` | `{ 'handles.$**': 1 }`                                 | Identity search over handle values                                             |
| `lastInteractionAt_-1`             | `{ lastInteractionAt: -1 }`                            | People list under `?sort=lastInteractionAt:-1`                                 |
| `people_text`                      | `{ displayName: 'text', notes: 'text', tags: 'text' }` | `?query=…` search                                                              |
| `deletedAt_1`                      | `{ deletedAt: 1 }` (sparse)                            | Tombstone scan                                                                 |

`primaryEmail` is **not unique** on purpose — multiple Person rows with the same email can briefly coexist (e.g. mid-merge), and the ingest path's `upsertPerson` is the keeper of "one row per email" in practice.

### `organizations`

```ts
{
  _id:           ObjectId
  name:          string                    // required
  domain:        string?                   // lowercased, trimmed; unique sparse
  website:       string?
  industry:      string?
  notes:         string?
  source:        ...
  sourceVersion: string?
  deletedAt:     Date | null
  createdAt, updatedAt
}
```

Indexes:

| Name          | Key                             | Purpose                                 |
| ------------- | ------------------------------- | --------------------------------------- |
| `domain_1`    | `{ domain: 1 }` (unique sparse) | One org per domain; `null` rows allowed |
| `deletedAt_1` | `{ deletedAt: 1 }` (sparse)     | Tombstone scan                          |

### `interactions`

`apps/api/src/db/models/Interaction.ts`. The CRM's central event table.

```ts
CHANNEL_VALUES     = ['email', 'calendar', 'in_person', 'call', 'message', 'manual']
PARTICIPANT_ROLES  = ['from', 'to', 'cc', 'attendee', 'subject']
INTERACTION_STATUS = ['active', 'cancelled']

{
  _id:           ObjectId
  occurredAt:    Date                      // required — when the interaction happened
  channel:       enum CHANNEL_VALUES        // required
  title:         string                    // required (subject line, event summary, …)
  body:          string (default '')       // text/plain body; HTML stripped on the way in
  sourceRef:     { provider: 'gmail' | 'gcal', id: string } | null
  participants: [{                         // min 1 (validated)
    personId: ObjectId,                    // ref: 'Person'
    role:     enum PARTICIPANT_ROLES,
  }]
  location:      string?
  attachments:  [{
    name:     string,
    mimeType: string?,
    size:     number?,
    ref:      string?,                     // gmail attachment id, scoped to the message
  }]
  context:       string[]                  // free-form tags
  status:        enum INTERACTION_STATUS (default 'active')
  source:        'concierge' | 'gmail-sync' | 'gcal-sync' | ...
  sourceVersion: string?
  deletedAt:     Date | null
  createdAt, updatedAt
}
```

Indexes:

| Name                                    | Key                                                                                                      | Purpose                                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occurredAt_-1`                         | `{ occurredAt: -1 }`                                                                                     | Time-sorted lists, digest                                                                                                                                                                     |
| `participants.personId_1_occurredAt_-1` | `{ 'participants.personId': 1, occurredAt: -1 }`                                                         | Per-person interaction timeline                                                                                                                                                               |
| **`interactions_sourceRef_unique`**     | `{ 'sourceRef.provider': 1, 'sourceRef.id': 1 }` (unique partial: `'sourceRef.id': { $type: 'string' }`) | One interaction per Gmail message / Calendar event. Concierge-created rows have `sourceRef: null` and are exempt from the partial filter. Hard guarantee that ingest replays don't duplicate. |
| `context_1_occurredAt_-1`               | `{ context: 1, occurredAt: -1 }`                                                                         | `/contexts` aggregation, `?context=…` filter                                                                                                                                                  |
| `interactions_text`                     | `{ title: 'text', body: 'text' }`                                                                        | `?query=…` search                                                                                                                                                                             |
| `deletedAt_1`                           | `{ deletedAt: 1 }` (sparse)                                                                              | Tombstone scan                                                                                                                                                                                |

**Schema validators**:

- `participants` must have `length >= 1`.
- The participant subdocument (`_id: false`) and source-ref / attachment subdocuments inherit `strict: 'throw'` from `baseSchemaOptions`.

### `recordInteraction.ts`

The only path that writes into `interactions`. Two entry points:

`recordInteraction(input, opts?)` — used by concierge POST and the Gmail worker.

1. `Interaction.create(input)`.
2. On code-11000 dup-key, if `opts.skipIfDuplicate === true`, returns `null`. Otherwise rethrows (the global error handler turns it into `409 conflict`).
3. On success, calls `touchLastInteraction(participantIds, occurredAt)` which `Person.updateMany({ _id: { $in } }, { $max: { lastInteractionAt: occurredAt } })`. `$max` is the right primitive — out-of-order ingest never moves the field backward.

`upsertInteractionBySourceRef(input)` — used by the Calendar worker to reconcile edits to existing events.

1. `findOneAndUpdate({ 'sourceRef.provider', 'sourceRef.id' }, { $set: { occurredAt, channel, title, body, participants, status, sourceRef, source, location?, attachments?, context?, sourceVersion? } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true })`.
2. The `participants` array is **replaced wholesale** — so attendee removals from a Calendar event are reflected in the next sync.
3. `lastInteractionAt` is bumped only when the upserted interaction is `active`. Cancelled events should not register as a recent touchpoint.

### `followups`

```ts
FOLLOWUP_DIRECTIONS = ['i_owe', 'they_owe']
FOLLOWUP_STATUSES   = ['open', 'done', 'snoozed', 'dismissed']

{
  _id:                 ObjectId
  personId:            ObjectId             // ref: 'Person'; required
  direction:           enum                  // required
  dueAt:               Date?                 // optional ("no due date" is a real state)
  duePriorityBucket:   0 | 1                 // maintained before validate: dated first, undated last
  status:              enum (default 'open')
  reason:              string                // required, min length 1
  sourceInteractionId: ObjectId | null       // ref: 'Interaction'
  source, sourceVersion, deletedAt, createdAt, updatedAt
}
```

Indexes:

| Name                                 | Key                                                                                 | Purpose                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `status_1_dueAt_1`                   | `{ status: 1, dueAt: 1 }`                                                           | Digest queries (`overdue` = open + dueAt<now; `upcoming` = open + now<=dueAt<=end) |
| `personId_1_direction_1_status_1`    | `{ personId: 1, direction: 1, status: 1 }`                                          | Per-person followup lists                                                          |
| `followups_due_priority_page`        | `{ status: 1, duePriorityBucket: 1, dueAt: 1, _id: -1 }`                            | `/followups?sort=duePriority:1` pagination                                         |
| `followups_due_priority_scoped_page` | `{ status: 1, personId: 1, direction: 1, duePriorityBucket: 1, dueAt: 1, _id: -1 }` | Scoped due-priority pagination                                                     |
| `deletedAt_1`                        | `{ deletedAt: 1 }` (sparse)                                                         | Tombstone scan                                                                     |

`duePriorityBucket` is derived, not caller-controlled: `0` when `dueAt` is present and `1` when it is absent. This lets the API sort dated followups first while keeping undated reminders paginable.

### Google refresh token

Not stored in Kizuna's Mongo anymore. The encrypted refresh token lives in **Kao's** `grants` collection — see `kao/docs/architecture.md`. Kizuna's `apps/api/src/lib/kao-client.ts` calls `GET ${KAO_URL}/grants/kizuna/token` at vend time; the access token is cached in module scope for `expiresAt − 30 s` and shared across concurrent ingest calls via an inflight de-dup. `clearAccessTokenCache()` resets both the cache and the inflight together (see `lib/kao-client.ts` for the rationale).

The legacy `oauthtokens` Mongoose model was deleted in the Kao migration; an existing row in your dev database can be removed with `db.oauthtokens.drop()` (it's no longer read by any code path).

### `syncstates`

`apps/api/src/db/models/SyncState.ts`. One row per provider, lazily created by the ingest workers.

```ts
{
  _id:           ObjectId
  provider:      'gmail' | 'gcal'           // required, unique
  historyId:     string | null              // Gmail's incremental cursor
  syncToken:     string | null              // Calendar's incremental cursor
  lastRunAt:     Date | null
  errorCount:    number (default 0)         // monotonic; cleared on a successful run
  lastError:     string | null              // human-readable last error message
  pausedAt:      Date | null                // set on invalid_grant; cleared on re-grant or `force: true`
  source, sourceVersion, deletedAt, createdAt, updatedAt
}
```

Indexes:

| Name          | Key                         | Purpose                             |
| ------------- | --------------------------- | ----------------------------------- |
| (auto)        | `{ provider: 1 }` (unique)  | One row per provider                |
| `deletedAt_1` | `{ deletedAt: 1 }` (sparse) | Tombstone scan (not currently used) |

The semantics around `historyId`, `syncToken`, `pausedAt`, and `force` are documented in [sync.md](sync.md).

## Serialization

`apps/api/src/lib/serialize.ts` is the only path from a Mongoose lean doc to a wire response. Each `serialize<Model>` does three things:

1. Converts ObjectIds to hex strings (`oidString`).
2. Replaces `undefined` with `null` for nullable fields so the response shape is stable.
3. Converts Mongoose `Map`s (notably `Person.handles`) to plain objects.

The dashboard hand-mirrors these shapes in `apps/dashboard/src/lib/types.ts` — keep that file in sync when shapes change.
