# Sync

The Gmail + Calendar ingest pipeline lives at `apps/api/src/ingest/`. Two workers, one scheduler, one shared Kao-backed token vend. Both workers share the same skeleton: state machine in Mongo + paginated fetch + pure parser + idempotent write through `recordInteraction.ts`.

## Layout

```
apps/api/src/ingest/
├── scheduler.ts        # setInterval-driven tick; re-entrancy guard
├── gmail.ts            # bootstrap (date window) → incremental (history)
├── gmail-client.ts     # thin fetch wrapper around gmail.googleapis.com (self-heals on 401)
├── parse-message.ts    # Gmail message JSON → ParsedMessage (pure)
├── calendar.ts         # bootstrap → sync-token incremental + reconciliation
├── calendar-client.ts  # fetch wrapper around calendar.googleapis.com (self-heals on 401)
├── parse-event.ts      # Calendar event → ParsedEvent (pure)
└── upsert-person.ts    # find-or-create by lowercased email, respects suppressReingest
```

## Auth + token handling

Both workers go through `getAccessToken(config, options?)` in `apps/api/src/lib/kao-client.ts`:

1. If `options.force`: clear local cache+inflight, then vend with `?force=1` so Kao bypasses its own cache and round-trips to Google.
2. Otherwise: module-scope cache returns the access token if `expiresAt > Date.now() + 30 s`. Concurrent callers share one in-flight fetch.
3. `GET ${KAO_URL}/grants/kizuna/token` with `Authorization: Bearer ${KAO_TOKEN}`. Kao decrypts the stored refresh token, refreshes at Google, and returns `{ accessToken, expiresAt, scopes }`.
4. Kao taxonomy → `OAuthError` on the boundary so workers keep their stable matching:
   - Kao 409 `no_grant` → `OAuthError('no_grant')`
   - Kao 409 `invalid_grant` / `decrypt_failed` → `OAuthError('invalid_grant')`
   - Kao unreachable, 401/404, malformed body, or implausible `expiresAt` → `OAuthError('refresh_failed')`

`clearAccessTokenCache()` clears both `cache` and `inflight` together so a force-refresh isn't overwritten by a stale in-flight result.

The Gmail and Calendar HTTP clients add a self-heal retry on top: on a 401 or 403 from Google, they call `getAccessToken({ force: true })` and retry the request once. Only the second 401 escapes the client (as `GmailHttpError(401)` / `CalendarHttpError(401)`); the worker then maps that to `OAuthError('invalid_grant')` and pauses.

The refresh-token scopes for the `kizuna` grant are version-controlled in Kao's registry (`kao/apps/api/src/grant-registry.ts`):

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar.readonly
```

## Scheduler

`apps/api/src/ingest/scheduler.ts`:

```ts
startIngestScheduler({ config }) → { stop() }
```

- If `KIZUNA_INGEST_INTERVAL_SEC === 0` (the default), the scheduler is a no-op. Manual triggers via `POST /sync/{gmail,gcal}/run` still work.
- Otherwise: `setInterval(tick, intervalSec * 1000)`. Each tick runs Gmail then Calendar sequentially; failures are logged but not rethrown so the next tick still fires. Per-provider outcome is logged via `logTick`: `debug` for an idle tick (nothing fetched, no errors, status `ok`) — silent at the default `info` level — `info` when something changed or status isn't `ok`, and `warn` on per-run errors. Messages are `"<provider> ingest tick"` / `"… (idle)"` / `"… : N error(s)"`.
- A `running = true` flag guards against overlapping ticks (if a tick takes longer than the interval, the next is skipped with `logger.warn('ingest tick skipped')`).
- **No tick on startup.** First tick is one full interval after boot; this avoids surprise sync runs on `tsx watch` reloads.
- Real Gmail and Calendar clients wrap every Google `fetch` in `AbortSignal.timeout(30_000)`. A timeout is recorded as `gmail_request_timeout` or `gcal_request_timeout` in `SyncState.lastError` and the run does not advance its cursor.

## Gmail worker (`runGmailSync`)

`apps/api/src/ingest/gmail.ts`. Two modes, picked by whether `SyncState.historyId` is set:

### Bootstrap (first run)

1. `client.getProfile()` → `{ emailAddress, historyId }`.
2. Build a Gmail query string: `after:YYYY/M/D` for the date `KIZUNA_GMAIL_BACKFILL_DAYS` ago (default 30).
3. Paginate `users.messages.list({ q, maxResults: 100, pageToken? })` until `nextPageToken` is absent. Collect message IDs.
4. `processMessageIds(ids)` (see below).
5. Persist `historyId` from the bootstrap profile as the cursor for the next incremental run.

### Incremental (subsequent runs)

1. Paginate `users.history.list({ startHistoryId, historyTypes: 'messageAdded', maxResults: 500, pageToken? })`. Walk every `historyEvents[].messagesAdded[].message.id` into a `Set<string>` of new IDs.
2. Track the latest `historyId` seen across pages.
3. `processMessageIds([...newIds])`.
4. Write `historyIdAfter` (the latest seen) back to `SyncState`.

Gmail's history API is "since this point in time," not "every change since." That's why bootstrap uses message-list: a fresh deploy needs a one-shot crawl.

### `processMessageIds(ids)`

Per ID:

1. `client.getMessage(id, format: 'full')`. If 401 mid-batch → throw `OAuthError('invalid_grant')` so the outer try-catch can pause the worker (we don't want to keep hammering with a stale token). If the request hits the 30-second Google timeout, throw it to the outer sync failure path so `SyncState` keeps the old cursor instead of skipping the message.
2. `parseGmailMessage(raw)` — pure parser. Headers → `From / To / Cc / Bcc / Subject / Date / List-Unsubscribe`. Body → prefer `text/plain`; fall back to `text/html` stripped (`<style>`/`<script>` removed, block tags → newlines, common HTML entities decoded). Attachments → flat list of `{ name, mimeType, size, ref }` where `ref` is Gmail's per-message `attachmentId`. `occurredAt` is the parsed `Date` header, falling back to `internalDate`, falling back to `now`.
3. **Newsletter filter.** If the message has a `List-Unsubscribe` header, OR the sender's domain is in `NEWSLETTER_DOMAIN_BLOCKLIST` → `result.skippedNewsletter++; continue`. Newsletters are noise in a relationship CRM.
4. **Skip-self on group threads.** If the count of non-`USER_EMAILS` recipients in `to + cc` is `>= 2`, drop the user's own addresses. Otherwise keep all recipients (a one-on-one with yourself stays linked). The `from` role is preserved either way, so outbound detection (sender ∈ `USER_EMAILS`) still works downstream.
5. For each remaining address (deduped by lowercased email): `upsertPerson({ email, displayName, occurredAt, source: 'gmail-sync' })`. See "Upsert person" below.
6. If no participants resolved → log warn + `result.errors++`; skip insert.
7. `recordInteraction({ channel: 'email', sourceRef: { provider:'gmail', id }, ... }, { skipIfDuplicate: true })`. The unique partial index on `(sourceRef.provider, sourceRef.id)` makes duplicates a Mongo-level no-op; `skipIfDuplicate` swallows the E11000 and returns `null`. The result is `result.inserted++` for new rows and `result.skippedExisting++` when the row already existed.

### Result shape

```ts
{
  status: 'ok' | 'paused' | 'no_grant' | 'error';
  fetched: number;            // messages successfully fetched (excludes 401s and parse failures)
  inserted: number;
  skippedExisting: number;    // dup-key on sourceRef
  skippedNewsletter: number;  // List-Unsubscribe or domain blocklist
  errors: number;
  historyIdAfter: string | null;
  message?: string;           // human-readable explanation when status !== 'ok'
}
```

### Pause + resume semantics

- On `OAuthError('invalid_grant')` or a Gmail 401 outside `getMessage` → `pauseWith(message)`: log at `error` (`"<provider> ingest paused — re-grant required"`, with `provider` + `reason` — pausing freezes ingest until a manual re-grant, so it is not a silent state mutation), then set `pausedAt: now`, increment `errorCount`, write `lastError`. Subsequent runs short-circuit with `{ status: 'paused' }` until either:
  - The user re-authorizes via `/oauth/google/start` → `/callback`, which calls `SyncState.updateMany({ pausedAt: { $ne: null } }, { pausedAt: null, lastError: null })`; or
  - The caller passes `force: true` to `POST /sync/gmail/run`, which clears `pausedAt` and runs once.
- On any other error → write `lastError` + bump `errorCount` (without setting `pausedAt`). Next tick retries.
- On Google request timeout → write `gmail_request_timeout` to `lastError` + bump `errorCount` (without setting `pausedAt`). Next tick retries from the previous cursor.
- A successful run clears `lastError` and writes `lastRunAt`. `errorCount` is monotonic — it isn't cleared on success today.

## Calendar worker (`runCalendarSync`)

`apps/api/src/ingest/calendar.ts`. Same skeleton, slightly different cursor.

### Bootstrap

1. `events.list({ timeMin, singleEvents: true, showDeleted: true, orderBy: 'startTime', maxResults: 250 })` — `timeMin` = now minus `KIZUNA_GCAL_BACKFILL_DAYS` (default 60).
2. Paginate via `pageToken`; remember `nextSyncToken` (only present on the last page).
3. `processEvent(ev)` for each item.
4. Persist `nextSyncToken` as the cursor for the next incremental run.

### Incremental

1. `events.list({ syncToken, singleEvents: true, showDeleted: true, maxResults: 250 })`. No `timeMin`, no `orderBy`.
2. Paginate; remember `nextSyncToken`.
3. `processEvent(ev)` for each item — Google's incremental list returns both new events and edited/cancelled ones.

### `SyncTokenExpired` (HTTP 410)

Sync tokens expire after roughly seven days of inactivity, or when Google's retention horizon advances past them. The client maps `410 Gone` to a `SyncTokenExpired` exception. The worker catches it, calls `clearSyncToken()`, and re-bootstraps:

```ts
try {
  after = startToken
    ? await incremental(startToken, ...)
    : await bootstrap(...);
} catch (err) {
  if (err instanceof SyncTokenExpired) {
    await clearSyncToken();
    result.resyncedFromBootstrap = true;
    after = await bootstrap(...);
  } else {
    throw err;
  }
}
```

`resyncedFromBootstrap: true` surfaces in the result so the dashboard / operator can see the rebootstrap happened.

### `processEvent(ev)`

1. `parseCalendarEvent(ev)` — pure parser. Maps `start.dateTime` (or `start.date` for all-day events) to `occurredAt`. `cancelled = ev.status === 'cancelled'`. Title falls back to `'(no title)'`. Resolves organizer + attendees with case-folded emails.
2. **Skip-self on group events.** If the count of non-`USER_EMAILS` attendees is `>= 2`, drop user's own addresses. Organizer (role `'from'`) is preserved either way so outbound detection still works.
3. `upsertPerson(...)` for organizer (role `'from'`) and each remaining attendee (role `'attendee'`).
4. If no participants resolve → skip insert (still increments `cancelled` if applicable).
5. `upsertInteractionBySourceRef({ channel: 'calendar', sourceRef: { provider:'gcal', id }, status: cancelled ? 'cancelled' : 'active', ... })`. Note: this is **upsert**, not insert. Edits to an existing event (title change, time change, attendee added or removed) overwrite the stored interaction in place. The `participants` array is replaced wholesale.
6. `lastInteractionAt` is bumped only when the upserted interaction is `active`. Cancelled events should not register as a recent touchpoint.

### Result shape

```ts
{
  status: 'ok' | 'paused' | 'no_grant' | 'error';
  fetched: number;
  upserted: number;            // includes both inserts and edits
  cancelled: number;           // events processed with status === 'cancelled'
  errors: number;
  syncTokenAfter: string | null;
  resyncedFromBootstrap: boolean;
  message?: string;
}
```

Pause + resume semantics are identical to Gmail. Google request timeouts write `gcal_request_timeout` to `lastError` + bump `errorCount` without advancing the sync token, so the next tick retries from the previous cursor.

## `upsertPerson` (`apps/api/src/ingest/upsert-person.ts`)

Find-or-create by lowercased email. The same path is hit by both workers; `source: 'gmail-sync'` or `'gcal-sync'` is set by the caller.

Spec (enforced by tests):

1. Match on lowercased `primaryEmail`.
2. **`suppressReingest === true`** → return existing `personId`; do not mutate the row. The interaction will still link to it, but its `displayName`, `deletedAt`, etc. are left alone. This is what makes Person tombstones sticky against future syncs.
3. `suppressReingest === false` on a tombstoned row → "rare; e.g. after a manual undelete." Treat as a normal upsert: clear `deletedAt` + apply the usual updates.
4. Updates applied to existing un-suppressed rows:
   - If `displayName` is missing or equals the email, replace with the parsed display name (if it's not also the email).
   - If `deletedAt` was set and `suppressReingest` is false, clear it (un-tombstone).
5. Brand new row: `{ displayName, primaryEmail, emails: [email], firstSeen: occurredAt, source }`.

Returns `{ personId, created, tombstonedSuppressed }`.

## Idempotence

The whole pipeline is replay-safe:

- **Gmail**: messages are addressed by their immutable `id`. The unique partial index on `(sourceRef.provider, sourceRef.id)` makes a re-fetch + re-insert a Mongo-level no-op. `skipIfDuplicate: true` in `recordInteraction` translates that to `result.skippedExisting++` instead of an error.
- **Calendar**: `upsertInteractionBySourceRef` upserts on the same `(provider, id)` filter. Edits propagate; participants are replaced wholesale.
- **People**: `upsertPerson` is a find-or-create; concurrent ingest of the same address from Gmail and Calendar resolves to the same row.

That's the whole point of `sourceRef` carrying the provider's stable ID instead of a content hash: Google is the source of truth, and the local mirror eventually converges.

## Failure modes — quick reference

| Trigger                                             | What happens                                                                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kao 409 `no_grant` (no consent yet on Kao)          | `OAuthError('no_grant')` → `result.status = 'no_grant'`. Not a pause; just an empty run.                                                                              |
| `KAO_URL`/`KAO_TOKEN` missing                       | Caught at the route level (`POST /sync/.../run`) — `400 bad_request`. Direct calls to `getAccessToken` raise `OAuthError('refresh_failed')`.                          |
| Kao 409 `invalid_grant` / `decrypt_failed`          | `OAuthError('invalid_grant')` → `pauseWith('invalid_grant')`. Operator re-consents at `${KAO_URL}/oauth/kizuna/start`, then `force: true` clears the pause.           |
| Kao unreachable / 5xx / bad bearer (401)            | `OAuthError('refresh_failed')` → `recordFailedRun(msg)`, `errorCount++`. Next scheduler tick (or manual run) retries.                                                 |
| Google 401 inside a client call                     | Client transparently retries with `getAccessToken({ force: true })` (Kao bypasses **its** cache via `?force=1`). A persistent 401 escapes → pause as `invalid_grant`. |
| Calendar 410 on syncToken                           | `clearSyncToken()` + rebootstrap; `resyncedFromBootstrap: true` in the result.                                                                                        |
| Single message / event fails to fetch or parse      | `result.errors++`, `logger.warn`, continue to next ID. Whole run still succeeds.                                                                                      |
| Mongo dup-key on `sourceRef`                        | `recordInteraction` returns `null` (`skipIfDuplicate`); `result.skippedExisting++`.                                                                                   |
| Tombstoned `Person` (with `suppressReingest: true`) | New interactions still link via the existing `personId`. The Person row itself is left alone.                                                                         |

## Ad-hoc imports

`apps/api/scripts/import-vcards.ts` is a one-shot script that parses an Apple Contacts vCard export and POSTs each card to `/people`. It uses the regular concierge API (no auth at single-user localhost) and is not part of the scheduler. Conflicts (`409` from the unique-domain index, etc.) are counted but not rethrown.
