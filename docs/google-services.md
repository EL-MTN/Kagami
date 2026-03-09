# Google Services Integration

Mashiro integrates with Gmail and Google Calendar to perform real assistant tasks — checking email, managing schedules, and setting reminders.

## OAuth Setup

### Prerequisites

1. A Google Cloud project with Gmail API and Google Calendar API enabled
2. An OAuth 2.0 client ID (Desktop type) created in the Google Cloud Console

### Getting a Refresh Token

```bash
# Set your client credentials
export GOOGLE_OAUTH_CLIENT_ID="your-client-id"
export GOOGLE_OAUTH_CLIENT_SECRET="your-client-secret"

# Run the authorization script
npm run auth:google
```

The script will:

1. Print an authorization URL — open it in your browser
2. Sign in and grant access to Gmail (read-only) and Calendar (full access)
3. Paste the authorization code back into the terminal
4. Output the refresh token to add to your `apps/bot/.env`

### Environment Variables

```env
GOOGLE_OAUTH_CLIENT_ID=your-client-id
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
GOOGLE_OAUTH_REFRESH_TOKEN=your-refresh-token
```

All three must be set together (validated at startup). If none are set, Google services are disabled — the LLM won't see the tools and the maid service instructions won't be injected.

### OAuth Scopes

| Scope            | Purpose                                   |
| ---------------- | ----------------------------------------- |
| `gmail.readonly` | Read email messages and metadata          |
| `gmail.send`     | Send emails on behalf of the user         |
| `calendar`       | Full read/write access to Google Calendar |

## Architecture

```
apps/bot/src/services/
├── google-auth.ts        Lazy OAuth2Client singleton
├── gmail.ts              Gmail API wrappers
└── google-calendar.ts    Calendar API wrappers

packages/db/src/models/
└── reminder.ts           Reminder MongoDB model

apps/bot/src/scheduler/
└── reminders.ts          Reminder polling scheduler

apps/bot/src/ai/tools/
├── check-email.ts        LLM tool for reading email
├── send-email.ts         LLM tool for sending email
├── manage-calendar.ts    LLM tool for calendar
└── manage-reminders.ts   LLM tool for reminders
```

### Google Auth (`apps/bot/src/services/google-auth.ts`)

Lazy singleton `OAuth2Client` from the `googleapis` package. Reads credentials from config and sets the refresh token. The `googleapis` library handles silent access token refresh automatically.

### Gmail Service (`apps/bot/src/services/gmail.ts`)

| Function                        | Description                                                      |
| ------------------------------- | ---------------------------------------------------------------- |
| `listUnreadEmails(maxResults?)` | Lists unread emails with metadata (from, subject, snippet, date) |
| `getEmailById(messageId)`       | Retrieves full email body (plain text, truncated to 2000 chars)  |

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

### manageCalendar

- **Parameters**: `{ action: "list"|"create"|"update"|"delete", daysAhead?, maxResults?, eventId?, summary?, description?, start?, end?, location? }`
- **Behavior**: Dispatches to the appropriate calendar service function
- **Date format**: ISO 8601 datetime strings

### manageReminders

- **Parameters**: `{ action: "create"|"list"|"delete", message?, fireAt?, reminderId? }`
- **Behavior**: Creates, lists, or deletes reminders scoped to the current chat
- **Key design**: The LLM composes the reminder message at creation time — it's sent as-is when fired, not regenerated

## Conditional Activation

When Google OAuth credentials are configured:

- Four new tools are added to `allTools()` (`apps/bot/src/ai/tools/index.ts`)
- `MAID_SERVICE_INSTRUCTIONS` are injected into the system prompt (`apps/bot/src/ai/context-assembler.ts`)
- The curator formats tool calls for the new tools (`apps/bot/src/memory/curator.ts`)

When credentials are NOT configured, none of the above happens — the bot operates normally without maid capabilities.
