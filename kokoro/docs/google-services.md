# Google Services Integration

Kokoro integrates with Gmail and Google Calendar to perform real assistant tasks — checking email, managing schedules, and setting reminders.

**Identity is delegated to Kao.** Kokoro no longer owns Google OAuth client credentials or a refresh token; it asks the [Kao identity service](../../kao/CLAUDE.md) for a fresh access token on demand. The historical CLI authorization script and the plaintext `GOOGLE_OAUTH_REFRESH_TOKEN` in `apps/bot/.env` are gone.

## Setup

### Prerequisites

1. Kao itself is running and the `kokoro` grant has been registered in Kao's `grant-registry.ts` (it ships pre-registered with the scopes Kokoro needs).
2. The Google Cloud OAuth client (registered in Kao, not here) has the Gmail and Calendar APIs enabled.

### Granting consent

```
1. Open https://api.kao.localhost/ in your browser.
2. Find the `kokoro` row, click "Connect Google".
3. Consent on Google. Land back at Kao's success page.
```

That's it — there is no Kokoro-side script. Kao stores the refresh token (AES-256-GCM encrypted in Mongo) and vends short-lived access tokens.

### Environment variables

```env
KAO_URL=https://api.kao.localhost
KAO_TOKEN=<the bearer Kao expects on /grants/*>
```

Both must be set together (validated at startup in `packages/shared/src/config.ts`). If neither is set, Google services are disabled — the LLM doesn't see the email/calendar/reminder tools and the maid-service instructions aren't injected into the system prompt. This is the same activation behavior as before; only the _gate_ changed (`KAO_URL` instead of `GOOGLE_OAUTH_CLIENT_ID`).

### Scopes

The `kokoro` grant in Kao's registry is consented for exactly:

| Scope            | Purpose                                   |
| ---------------- | ----------------------------------------- |
| `gmail.readonly` | Read email messages and metadata          |
| `gmail.send`     | Send emails on behalf of the user         |
| `calendar`       | Full read/write access to Google Calendar |

Identical to the pre-Kao set — capability is preserved.

## Architecture

```
apps/bot/src/services/
├── kao-client.ts          NEW — vends access tokens from Kao; per-grant cache; structured errors
├── google-auth.ts         Async — async getGoogleAuth() returns an OAuth2Client with a fresh access token
├── gmail.ts               Gmail API wrappers (now await getGoogleAuth)
└── google-calendar.ts     Calendar API wrappers (now await getGoogleAuth)

packages/db/src/models/
└── reminder.ts            Reminder MongoDB model (unchanged)

apps/bot/src/scheduler/
└── reminders.ts           Reminder polling scheduler (unchanged)

apps/bot/src/ai/tools/
├── email.ts               LLM tools for reading + sending email (checkEmail, sendEmail)
└── calendar.ts            LLM tools for calendar + reminders (manageCalendar, manageReminders)
```

### Kao client (`apps/bot/src/services/kao-client.ts`)

- `getAccessToken()` — calls `GET ${KAO_URL}/grants/kokoro/token` with `Authorization: Bearer ${KAO_TOKEN}` (via `tracedFetch`, so the W3C trace context propagates to Kao). Caches the returned token in-process with a 30 s safety buffer that matches Kao's own internal cache policy. Back-to-back gmail/calendar calls within an LLM turn typically hit this cache and never go over the network.
- **Error taxonomy:**
  - `KaoMisconfiguredError` — `KAO_URL`/`KAO_TOKEN` unset, or Kao returned 401/404 (bearer wrong or grant unknown). Operator config issue — does not cache.
  - `KaoNoGrantError { code: "no_grant" | "invalid_grant" }` — Kao returned 409. The message contains a `${KAO_URL}/oauth/kokoro/start` link so the operator can re-consent. `invalid_grant` distinguishes "Google rejected the stored refresh" from "never consented".
  - `KaoUnreachableError` — network failure or unexpected 5xx. Transient.

### Google Auth (`apps/bot/src/services/google-auth.ts`)

`async getGoogleAuth(): Promise<OAuth2Client>` — asks `kao-client` for an access token and builds a fresh `OAuth2Client` with `setCredentials({ access_token })`. The `googleapis` library uses the token as-is for the call; refresh is **Kao's job**, not the library's (no refresh token is set client-side, by design).

The OAuth2Client is constructed per call. It's cheap, and avoiding a singleton means a re-issued token from Kao takes effect on the very next call without any explicit cache invalidation here.

### Gmail Service (`apps/bot/src/services/gmail.ts`)

| Function                           | Description                                                      |
| ---------------------------------- | ---------------------------------------------------------------- |
| `listUnreadEmails(maxResults?)`    | Lists unread emails with metadata (from, subject, snippet, date) |
| `getEmailById(messageId)`          | Retrieves full email body (plain text, truncated to 2000 chars)  |
| `sendEmail({ to, subject, body })` | Sends an email via the Gmail API                                 |

### Calendar Service (`apps/bot/src/services/google-calendar.ts`)

| Function                                      | Description                               |
| --------------------------------------------- | ----------------------------------------- |
| `listUpcomingEvents(daysAhead?, maxResults?)` | Lists events within the given time window |
| `createEvent(params)`                         | Creates a new calendar event              |
| `updateEvent(eventId, params)`                | Updates an existing event                 |
| `deleteEvent(eventId)`                        | Deletes an event                          |

### Reminder System

Reminders are stored in MongoDB and polled by a scheduler.

**Model** (`packages/db/src/models/reminder.ts`):

- Schema: `{ chatId, message, fireAt, fired, createdAt }`
- Index: `{ fired: 1, fireAt: 1 }` for efficient polling

**Scheduler** (`apps/bot/src/scheduler/reminders.ts`):

- Polls every 60 seconds via `setInterval` (`.unref()`)
- Fires pending reminders via `adapter.sendText()`
- Startup recovery: immediately fires any reminders that were due while the process was down
- Separate from the proactive scheduler — reminders are deterministic time-based, not personality-driven

## LLM Tools

### checkEmail

- **Parameters**: `{ maxResults?: number, emailId?: string }`
- **Behavior**: Lists unread emails or retrieves a specific email by ID
- **Returns**: `{ success, count?, emails? }` or `{ success, email }` or `{ success: false, reason }`

### sendEmail

- **Parameters**: `{ to: string, subject: string, body: string }`
- **Behavior**: Sends an email on behalf of the user. Approval-gated via the confirmation primitive (see `docs/confirmations.md`).

### manageCalendar

- **Parameters**: `{ action: "list"|"create"|"update"|"delete", daysAhead?, maxResults?, eventId?, summary?, description?, start?, end?, location? }`
- **Behavior**: Dispatches to the appropriate calendar service function
- **Date format**: ISO 8601 datetime strings

### manageReminders

- **Parameters**: `{ action: "create"|"list"|"delete", message?, fireAt?, reminderId? }`
- **Behavior**: Creates, lists, or deletes reminders scoped to the current chat
- **Key design**: The LLM composes the reminder message at creation time — it's sent as-is when fired, not regenerated

## Conditional Activation

When `KAO_URL` (and `KAO_TOKEN`) are configured:

- Four new tools are added to `allTools()` (`apps/bot/src/ai/tools/index.ts`)
- The maid-service instructions in `apps/bot/context/instructions/maid-service.md` are loaded by `assemblePromptShell()` (`apps/bot/src/ai/context-assembler.ts`) and injected into the system prompt
- The curator formats tool calls for the new tools (`apps/bot/src/memory/curator.ts`)

When `KAO_URL` is NOT configured, none of the above happens — the bot operates normally without maid capabilities. The same gate also drives a "no external observation tools" warning when creating watchers (`apps/bot/src/ai/tools/watchers.ts`).

## Re-consent flow

When Google rejects the stored refresh (typically because the user revoked Kokoro's access on the Google account, or the refresh expired):

1. Kao's vend endpoint returns `409 { error: { details: { code: "invalid_grant" } } }`.
2. The `kao-client` surfaces `KaoNoGrantError { code: "invalid_grant" }` — the tool layer returns `{ success: false, reason }`, the LLM tells the operator.
3. Operator visits `${KAO_URL}/` and clicks "Re-consent" on the `kokoro` row.
4. The next vend call succeeds; Kokoro continues uninterrupted (no Kokoro restart needed).
