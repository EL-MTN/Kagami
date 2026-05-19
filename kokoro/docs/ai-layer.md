# AI Layer

The AI layer handles LLM integration, prompt assembly, tool orchestration, image generation, and response delivery. All code lives under `apps/bot/src/ai/` and `apps/bot/src/context/`.

## Provider Configuration

Defined in `apps/bot/src/ai/provider.ts`. Chat goes through the shared
`@kagami/llm` gateway (`createInference`, `kind: "native"`) — the gateway owns
provider/key construction, retry, same-tier fallback, and span/usage emission;
`provider.ts` stays the caller-side **tier policy** (the `ModelTier` → model-id
map). Image / TTS / STT still use the Vercel AI SDK directly.

| Env Variable                 | Description                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LLM_KIND`                   | `"native"` (only supported value for Kokoro chat; default)                                                                                                         |
| `LLM_PROVIDER`               | `"anthropic"` (default), `"openai"`, or `"xai"`                                                                                                                    |
| `LLM_MODEL`                  | Default-tier model id (default: `"claude-sonnet-4-6"`; recommended xAI model: `grok-4-1-fast-non-reasoning`)                                                       |
| `LLM_MODEL_FAST`             | Optional override for the `Fast` tier (unset → per-provider default below)                                                                                         |
| `LLM_MODEL_SMART`            | Optional override for the `Smart` tier (unset → per-provider default below)                                                                                        |
| `ANTHROPIC_API_KEY`          | Required if provider is `anthropic` (validated at startup)                                                                                                         |
| `OPENAI_API_KEY`             | Required if provider is `openai` (validated at startup)                                                                                                            |
| `XAI_API_KEY`                | Required if provider is `xai` (validated at startup)                                                                                                               |
| `IMAGE_GENERATION_MODEL`     | Image model in `provider/model` format (e.g., `xai/grok-imagine-image`, `google/gemini-2.5-flash-image`, `openai/gpt-image-1`). Enables `sendPhoto` tool when set. |
| `TTS_PROVIDER`               | TTS model in `provider/model` format (e.g., `elevenlabs/eleven_flash_v2_5`). Enables `sendVoice` tool when set.                                                    |
| `TTS_VOICE_ID`               | ElevenLabs voice identifier                                                                                                                                        |
| `ELEVENLABS_API_KEY`         | Required when `TTS_PROVIDER` is set                                                                                                                                |
| `GOOGLE_API_KEY`             | Required for embedding generation (Google Gemini `gemini-embedding-001`)                                                                                           |
| `EMBEDDING_MODEL`            | Embedding model name (default: `"gemini-embedding-001"`)                                                                                                           |
| `KIZUNA_URL`                 | Kizuna API base URL for CRM tools — reads call directly, writes are confirmation-gated (default: `https://api.kizuna.localhost`)                                   |
| `KIZUNA_ENABLED`             | Feature gate for CRM tools; defaults to `true`, set `false` to omit them from all tool palettes                                                                    |
| `LOCATION_ENABLED`           | Feature gate for location awareness (default: `false`)                                                                                                             |
| `GOOGLE_MAPS_API_KEY`        | Google Maps Geocoding API key (required when `LOCATION_ENABLED=true`)                                                                                              |
| `LOCATION_CONTEXT_MAX_AGE_H` | Max age in hours for location data to appear in LLM context (default: `12`)                                                                                        |

`getModel(tier?)` returns a `LanguageModel` from the `@kagami/llm` gateway
(retry, same-tier fallback, span/usage applied); `getModelName(tier?)` resolves
just the model-id string for token accounting without constructing a provider.

### Model Tiers

The `ModelTier` enum lets call sites declare intent rather than hardcoding model IDs. `provider.ts` resolves each tier to a model id and passes the map to `@kagami/llm` as named aliases. The `Fast`/`Smart` columns are per-provider **defaults** — override either with `LLM_MODEL_FAST` / `LLM_MODEL_SMART`.

| Tier      | Purpose                              | Anthropic           | OpenAI             | xAI                           |
| --------- | ------------------------------------ | ------------------- | ------------------ | ----------------------------- |
| `Default` | Conversations, curation              | `config.LLM_MODEL`  | `config.LLM_MODEL` | `config.LLM_MODEL`            |
| `Fast`    | Cheap classification (ref selection) | `claude-haiku-4-5`  | `gpt-4o-mini`      | `grok-4-1-fast-non-reasoning` |
| `Smart`   | Maximum reasoning (reserved)         | `claude-sonnet-4-6` | `gpt-4o`           | `grok-4`                      |

## Context Assembly Pipeline

Implemented in `apps/bot/src/ai/context-assembler.ts`. The system prompt carries no facts — long-term memory is on-demand via the `searchMemory` tool, not pre-loaded. The shell is small and largely static; only routines, pending approvals, location, and (for proactive) reminders pull from MongoDB.

```
assembleSystemPrompt(chatId)
    │
    ├─ 1. Soul                       ← apps/bot/context/soul.md (file)
    ├─ 2. Current Mood               ← prompts.ts moodForTimeOfDay() — derived from time-of-day bucket
    ├─ 3. Datetime context           ← current time + time-of-day label
    ├─ 4. Tool behavior              ← apps/bot/context/instructions/tool-behavior.md
    ├─ 5. Maid service               ← apps/bot/context/instructions/maid-service.md (conditional on KAO_URL — Google access via Kao)
    ├─ 6. Web search                 ← apps/bot/context/instructions/web-search.md (conditional on BRAVE_SEARCH_API_KEY)
    ├─ 7. Browser                    ← apps/bot/context/instructions/browser.md (conditional on BROWSER_ENABLED)
    ├─ 8. Routine behavior           ← apps/bot/context/instructions/routines.md (always)
    ├─ 9. Routine context            ← listRoutinesForChat → enabled routine names (Mongo)
    ├─ 10. Pending approvals         ← listPendingConfirmations (Mongo)
    ├─ 11. Location context          ← last known location if within LOCATION_CONTEXT_MAX_AGE_H (Mongo, conditional on LOCATION_ENABLED)
    └─ 12. Response format           ← apps/bot/context/instructions/response-format.md

    All parts joined with "\n\n---\n\n"

assembleProactiveSystemPrompt(chatId)
    │
    ├─ shell (1–8 above)
    ├─ Active reminders              ← pending + recently fired (Mongo)
    ├─ Pending approvals             ← (Mongo)
    ├─ Location context              ← (Mongo, conditional)
    └─ Proactive message             ← apps/bot/context/instructions/proactive-message.md
```

Long-term memory (facts, prior conversations, milestones) is **not** pre-loaded into the prompt. The LLM calls `searchMemory(query)` when it needs context — the tool forwards to Kioku's hybrid retrieval (`@kokoro/memory.recall()` → `POST /recall`). See [memory.md](memory.md) for the full read/write paths.

The persona (`soul.md`) and operational instructions (`instructions/*.md`) are all file-based under `apps/bot/context/`. They are read on-demand and cached in-process by `(absolute path, mtime)` — edits to any of those files are picked up on the next turn without a restart. If an expected instruction file is missing on disk, `readInstruction()` logs a one-time warning per path and returns `null`; the caller skips that section so the assembled prompt remains well-formed. `prompts.ts` itself remains in code, holding `DATETIME_CONTEXT` (templated against `config.TIMEZONE`) and `moodForTimeOfDay()` (5-bucket lookup mirroring the time-of-day buckets). The conversational pipeline above is otherwise either Markdown or pulled from Mongo at assembly time. Note that the routine and watcher executors (see Routine and Watcher Execution below) build their own lean system prompts entirely in code — `ROUTINE_EXECUTOR_IDENTITY` / `WATCHER_EXECUTOR_IDENTITY` plus a templated report-mode instruction live as inline strings in `routine-executor.ts` / `watcher-executor.ts` and are not Markdown-backed.

### Datetime Context

Generated by `DATETIME_CONTEXT(now)` in `apps/bot/src/ai/prompts.ts`. Provides human-readable time and categorizes the period:

- Late night (12:00 AM–5:59 AM)
- Morning (6:00 AM–11:59 AM)
- Afternoon (12:00 PM–4:59 PM)
- Evening (5:00 PM–8:59 PM)
- Night (9:00 PM–11:59 PM)

### Message History

`assembleMessages(chatId)` loads the last 40 messages from the active session and reconstructs them for the AI SDK:

- User messages with images → multi-part content (image + text)
- Assistant messages with tool calls → toolCall + toolResult message pairs (recent only)
- **Tool result recency**: only the last 10 raw messages have their tool-call/tool-result pairs reconstructed. Older tool results are dropped to save context — the assistant's text response already contains the synthesized answer. Controlled by `TOOL_RESULT_KEEP_LAST`.

## Tool Definitions

Defined in `apps/bot/src/ai/tools/`. Tool files are consolidated by domain: `media.ts` (sendPhoto, sendVoice), `email.ts` (checkEmail, sendEmail), `calendar.ts` (manageCalendar, manageReminders), `confirmations.ts` (requestConfirmation, cancelConfirmation), `memory.ts` (searchMemory, rememberFact), `crm.ts` (read: findPeople, getPersonContext, recentInteractions, listMyFollowups; write: logInteraction, createFollowup, resolveFollowup, updatePerson — writes must be wrapped in `requestConfirmation`), `routines.ts` (manageRoutines, searchRoutines, useRoutine), `watchers.ts` (manageWatchers, reportWatcherResult), `browse.ts`, and `web-search.ts`. The barrel `index.ts` exports `allTools(ctx)` / `watcherTools(ctx)` / `routineToolsUnderWatcher(ctx)`. All tools are passed to `generateText()` and the LLM can invoke them across up to 5 steps.

### Tool Context

```typescript
interface ToolContext {
  chatId: string;
  adapter: PlatformAdapter;
  sessionId: string;
  userId?: string; // user driving the turn; absent for cron-triggered routines
  routineDepth?: number; // Current routine nesting depth (0 = top-level)
  callingContext?: "main" | "watcher"; // gates routine purity; defaults to "main"
}

allTools(ctx) → { rememberFact, searchMemory, findPeople?, getPersonContext?, recentInteractions?, listMyFollowups?, logInteraction?, createFollowup?, resolveFollowup?, updatePerson?, sendPhoto?, sendVoice?, checkEmail?, sendEmail?, manageCalendar?, manageReminders?, webSearch?, browse?, requestConfirmation?, cancelConfirmation?, manageRoutines, searchRoutines, useRoutine?, manageWatchers }

watcherTools(ctx) → { searchMemory, findPeople?, getPersonContext?, recentInteractions?, listMyFollowups?, reportWatcherResult, checkEmail?, listCalendarEvents?, webSearch?, browse? (read-only), useRoutine? }
```

Two distinct tool sets are assembled depending on the calling context:

- **`allTools(ctx)`** — full surface available to Mashiro in conversation and inside routine executors. Includes side-effecting tools (`sendEmail`, `rememberFact`, `manageReminders`, `sendPhoto`, etc.) plus CRM lookup tools when `KIZUNA_ENABLED` is true.
- **`watcherTools(ctx)`** — read-only subset for watcher executor ticks (`apps/bot/src/services/watcher-executor.ts`). Watchers observe; they never mutate external state. `searchMemory` and the Kizuna CRM **read** tools are included; `rememberFact` and the Kizuna CRM **write** tools (`logInteraction`, `createFollowup`, `resolveFollowup`, `updatePerson`) are excluded. The browse tool is the `createReadOnlyBrowseTool()` variant, which restricts actions to `search`/`visit`/`extract` and excludes `screenshot` (sends a photo), `act` (mutates page state), `agent`, and `login`. The calendar variant is `createManageCalendarTool({ mode: "readOnly" })`. `manageWatchers` is also excluded — watchers cannot create watchers.

### searchMemory

- **Purpose**: Hybrid retrieval (cosine + BM25 + entity boost) over Kioku's atomic-fact store. No LLM in the loop — returns ranked facts directly.
- **Parameters**: `{ query: string, k?: 1–20, since?: "YYYY-MM-DD", until?: "YYYY-MM-DD" }`
- **Returns**: `{ success: true, query, facts: [{ id, text, event_date, source_session, created_at }] }` or `{ success: false, reason, facts: [], degraded: true }` on Kioku outage (fail-open)
- **Behavior**: Forwards to `@kokoro/memory.recall()` → `POST /recall`. Default `k = 8`. Fails open: if Kioku is unreachable, returns an empty list with `degraded: true` so the model keeps responding instead of stalling.

### rememberFact

- **Purpose**: Append one atomic fact to the long-term memory vault.
- **Parameters**: `{ text: string (≤800 chars), eventDate?: "YYYY-MM-DD" }`
- **Returns**: `{ success: true, id, status: "added" | "duplicate", similarity? }` or `{ success: false, reason }` on Kioku error
- **Behavior**: Forwards to `@kokoro/memory.appendFactWithRetryQueue()` → `POST /facts`. Kioku does cosine ≥0.97 dedup against existing in-scope facts, embeds, lemmatizes for BM25, and upserts entity links. Idempotent — near-paraphrases of an existing fact return the existing id with `status: "duplicate"`. If Kioku append fails, Kokoro stores a `PendingFact` for `sweepPendingFacts` to retry. `eventDate` defaults to today; pass an explicit date when remembering something from the past.

See [memory.md](memory.md) for the full memory subsystem (session ingest, sweeper, transcript pipeline).

### CRM tools (conditional — `KIZUNA_ENABLED` defaults to true)

- **Purpose**: Read compact relationship context from Kizuna without loading raw CRM records into the prompt, plus concierge-style writes (logging interactions, creating/resolving followups, editing people) behind the confirmation primitive.
- **Read tools** (called directly):
  - `findPeople({ query, limit? })` searches stable identity fields with Kizuna `identityQuery`.
  - `getPersonContext({ personId })` returns one profile plus recent interactions and open followups.
  - `recentInteractions({ personId, channel?, since?, limit? })` lists event-time-sorted interactions.
  - `listMyFollowups({ direction?, status?, limit? })` lists Eric-relative followups in due-priority order.
- **Write tools** (must be wrapped in `requestConfirmation`):
  - `logInteraction({ occurredAt, channel, title, body?, participants, context?, location? })` → `POST /interactions`.
  - `createFollowup({ personId, direction, reason, dueAt?, sourceInteractionId? })` → `POST /followups`.
  - `resolveFollowup({ followupId, status, dueAt?, reason? })` → `PATCH /followups/:id`.
  - `updatePerson({ personId, displayName?, primaryEmail?, primaryOrgId?, relationship?, emails?, phones?, handles?, tags?, birthday?, notes? })` → `PATCH /people/:id`.
- **Returns**: `{ success: true, data, count?, truncated? }` or `{ success: false, reason, degraded?: true }`.
- **Behavior**: Calls `@kokoro/kizuna` over HTTP to `KIZUNA_URL` (default `https://api.kizuna.localhost`); reads are GET-only, writes use POST/PATCH and are listed in `GATED_TOOL_NAMES` so the gated dispatcher is the canonical run path. No auth header is sent. Results use compact projection types (`PersonSummary`, `InteractionSummary`, `FollowupSummary`) with excerpts for long text and opaque IDs intended only for follow-up tool calls. Read tools fail open with sanitized degraded results on Kizuna outages, disabled config, HTTP 5xx, transport, timeout, and schema failures; write tools fail closed (the dispatcher surfaces failures back through the acknowledgment turn). Write paths that succeed at the POST/PATCH but fail the post-write person hydration fall back to the missing-person placeholder so a successful mutation never surfaces as a thrown error.

### sendPhoto

- **Purpose**: Generate and send an AI photo/selfie
- **Parameters**: `{ description: string, caption?: string, aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" }`
- **Returns**: `{ sent: true, caption } | { sent: false, reason }`
- **Behavior**: Forwards the description to `generateImage`, which assembles the full prompt (appearance prefix from `context/image-prefix.md`, scene, outfit/setting instructions) and sends via adapter. On failure, the provider's error message is returned in `reason` so the LLM can explain what went wrong to the user.

### sendVoice (conditional — requires TTS_PROVIDER)

- **Purpose**: Send a voice message via TTS
- **Parameters**: `{ text: string }`
- **Returns**: `{ sent: true } | { sent: false, reason }`
- **Behavior**: Converts text to speech via ElevenLabs, then sends as a Telegram voice message. The LLM decides when voice fits naturally — emotional moments, teasing, singing, or when asked. Unlike photos, voice messages don't suppress the text response (no caption equivalent).

### checkEmail (conditional — requires Google OAuth)

- **Purpose**: Check Goshujin-sama's email
- **Parameters**: `{ maxResults?: number, emailId?: string }`
- **Returns**: `{ success, count?, emails? }` or `{ success, email }` or `{ success: false, reason }`
- **Behavior**: Lists unread emails or retrieves a specific email by ID. Only registered when `KAO_URL` is configured (Google access vended by Kao).

### requestConfirmation (conditional — requires `KAO_URL` or `BROWSER_ENABLED`)

- **Purpose**: Persist a pending action and ask Goshujin-sama to tap [Approve] / [Deny] before it runs
- **Parameters**: `{ summary: string, action: { tool: GatedToolName, args: Record<string, unknown> } }`
- **Returns**: `{ pending: true, confirmationId, message }` or `{ pending: false, success: false, reason }`
- **Behavior**: Persists a `PendingConfirmation` row, sends a Telegram message with inline `[✓ Approve][✗ Deny]` buttons via `adapter.sendConfirmationPrompt`, and returns immediately. The action is **not** executed in this turn — the LLM is instructed to stop. When the user taps a button, the Telegram callback handler atomically transitions the row to a terminal status BEFORE dispatch (race-safe), answers the callback query immediately ("Working…" / "Denied"), then dispatches via `dispatchGatedAction(tool, args)` if approved, edits the prompt bubble in place, appends a `[goshujin-sama approved/denied: ...]` event into conversation history, and finally fires `generateAcknowledgment` so Mashiro speaks one short in-character bubble about the outcome. While a row is pending, it appears in the system prompt under `## Pending Approvals` so the LLM doesn't re-prompt. `action.tool` is a Zod enum bound to `GATED_TOOL_NAMES` (currently `["sendEmail", "manageCalendar", "browseAgent", "logInteraction", "createFollowup", "resolveFollowup", "updatePerson"]`); see `docs/confirmations.md`.

### cancelConfirmation (conditional — registered alongside `requestConfirmation`)

- **Purpose**: Cancel a pending approval request from chat (when Goshujin-sama changes his mind without tapping the Deny button)
- **Parameters**: `{ confirmationId: string, reason?: string }`
- **Returns**: `{ success: true, confirmationId }` or `{ success: false, reason }`
- **Behavior**: Validates the confirmation belongs to the calling chat and is still pending, atomically transitions to `"cancelled"`, edits the prompt bubble in place to "✗ Cancelled · …", and appends a `[mashiro cancelled pending request: …]` event to conversation history. The id comes from the `## Pending Approvals` section of the system prompt.

### sendEmail (conditional — requires Google OAuth)

- **Purpose**: Send an email or reply to a thread on behalf of Goshujin-sama
- **Parameters**: `{ to: string, subject: string, body: string, threadId?: string, inReplyTo?: string }`
- **Returns**: `{ success: true, id, threadId }` or `{ success: false, reason }`
- **Behavior**: Composes a plain-text RFC 2822 message and sends via Gmail API. When `threadId` and `inReplyTo` are provided (from `checkEmail` results), sends as a threaded reply with proper `In-Reply-To` and `References` headers. Requires the `gmail.send` OAuth scope (consented under Kao's `kokoro` grant). Only registered when `KAO_URL` is configured.

### manageCalendar (conditional — requires Google OAuth)

- **Purpose**: Manage Google Calendar events
- **Parameters**: `{ action: "list"|"create"|"update"|"delete", daysAhead?, maxResults?, eventId?, summary?, description?, start?, end?, location? }`
- **Returns**: `{ success, event? }` or `{ success, events? }` or `{ success: false, reason }`
- **Behavior**: Dispatches to the appropriate calendar service function based on `action`. Date fields use ISO 8601 format.

### manageReminders (conditional — requires Google OAuth)

- **Purpose**: Manage reminders scoped to the current chat
- **Parameters**: `{ action: "create"|"list"|"delete", message?, fireAt?, reminderId? }`
- **Returns**: `{ success, reminderId? }` or `{ success, reminders? }` or `{ success: false, reason }`
- **Behavior**: Creates, lists, or deletes reminders. The LLM composes the reminder message at creation time — it's sent as-is when fired by the reminder scheduler.

### webSearch (conditional — requires BRAVE_SEARCH_API_KEY)

- **Purpose**: Quick factual web lookups via the Brave Search API — no browser, no lock, no LLM extraction
- **Parameters**: `{ query: string, count?: number (1–10, default 5) }`
- **Returns**: `{ success: true, query, results: [{ title, url, snippet }] }` or `{ success: false, reason }`
- **Behavior**: Single HTTP call to `https://api.search.brave.com/res/v1/web/search` with `X-Subscription-Token`. Maps Brave's `{title, url, description}` to the project's snippet shape and strips inline `<strong>` highlight tags. Surface errors are returned as a clean `reason` string the LLM can react to. Service in `apps/bot/src/services/web-search.ts`, tool in `apps/bot/src/ai/tools/web-search.ts`. Available to both `allTools` and `watcherTools` — gives memory-only watchers a cheap external-observation capability without the browser.

### browse (conditional — requires BROWSER_ENABLED=true)

- **Purpose**: Browse the web — visit pages, extract data, interact with elements, take screenshots, or complete multi-step autonomous tasks. When `BRAVE_SEARCH_API_KEY` is also set, the `search` action is dropped from the action enum so the LLM uses `webSearch` for lookups instead.
- **Parameters**: `{ action: "search"?|"visit"|"extract"|"act"|"screenshot"|"agent"|"login", query?, url?, instruction?, goal? }`
- **Returns**: Varies by action. Always includes `{ success: boolean }`.
- **Behavior**: Uses Stagehand (LLM-driven browser automation on accessibility tree). Supports two environments controlled by `BROWSER_ENV`: `local` runs a singleton Chromium instance with a persistent user profile, `cloud` delegates to Browserbase (requires `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`). Lazy-initialized on first call, auto-shuts down after 5 minutes idle. Every action is wrapped in `withBrowserLock` with a wall-clock timeout (2 min default, 10 min for `agent`); on timeout the singleton is reset so the next call re-inits.

| Action       | Required param | What it does                                                                                | Stagehand method                            |
| ------------ | -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `search`     | `query`        | DuckDuckGo search → structured results (fallback only when `BRAVE_SEARCH_API_KEY` is unset) | `page.goto()` + `extract()` with Zod schema |
| `visit`      | `url`          | Navigate + extract readable text (truncated 4000 chars)                                     | `page.goto()` + `page.evaluate(innerText)`  |
| `extract`    | `instruction`  | Structured extraction from current page                                                     | `stagehand.extract(instruction)`            |
| `act`        | `instruction`  | Interact with page (click, type, scroll)                                                    | `stagehand.act(instruction)`                |
| `screenshot` | —              | Capture page → send as photo                                                                | `page.screenshot()`                         |
| `agent`      | `goal`         | Autonomous multi-step task (up to 25 steps)                                                 | `stagehand.agent().execute()`               |
| `login`      | `url`          | Opens login page for manual credential entry                                                | `page.goto()` (no browser release)          |

**Architecture**: Two independent LLM streams — Kokoro's main loop (Sonnet) decides _what_ to browse, Stagehand's internal calls (Haiku/Fast tier) decide _how_ to navigate. Configured via `BROWSER_ENABLED`, `BROWSER_ENV` (`local`/`cloud`), `BROWSER_DATA_DIR`, `BROWSER_HEADLESS`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` env vars. Browser service in `apps/bot/src/services/browser.ts`, tool in `apps/bot/src/ai/tools/browse.ts`.

### searchRoutines

- **Purpose**: Search and discover available routines by keyword
- **Parameters**: `{ query?: string }`
- **Returns**: `{ success: true, count, routines: [{ name, description, parameters, cronSchedule, reportMode }] }` or `{ success: false, reason }`
- **Behavior**: Searches enabled routines for the current chat by matching keywords against routine names and descriptions. Call with no query to list all enabled routines. This is the primary discovery mechanism — the system prompt only lists routine names, so the LLM uses this tool to get full details (parameters, schedules) before invoking a routine.

### manageRoutines

- **Purpose**: Manage reusable routines — named capabilities with optional parameters and optional cron schedules
- **Parameters**: `{ action: "create"|"list"|"update"|"delete"|"enable"|"disable", routineId?, name?, description?, prompt?, parameters?, cronSchedule?, reportMode?, purity? }`
- **Returns**: `{ success, routineId? }` or `{ success, routines? }` or `{ success: false, reason }`
- **Behavior**: Creates, lists, updates, deletes, enables, or disables routines. Routines are named LLM-prompted capabilities stored in the database with typed parameters. Each routine has a `reportMode`: `"always"` sends a summary after every run, `"alert"` only messages when something noteworthy or an error occurs. Each routine also has a `purity` marker: `"read"` (routine only observes — search, summarize, query — and is safe to invoke from a watcher) or `"action"` (routine mutates external state — sends, writes, modifies — and watchers cannot invoke it). `purity` defaults to `"action"` if omitted on create, the conservative choice for backward-compat. Cron expressions are validated. Cron-scheduled routines require all required parameters to have defaults. Routine names are unique per chat (compound index). Version number increments on each update.

### useRoutine (conditional — omitted at max depth)

- **Purpose**: Invoke a routine by name with optional parameters
- **Parameters**: `{ routineName: string, parameters?: Record<string, unknown> }`
- **Returns**: `{ success: true, routineName, result }` or `{ success: false, reason }`
- **Behavior**: Looks up routine by name, validates parameters (type checking, required params, defaults), then executes synchronously via `executeRoutine()`. The result is returned to the calling LLM. Supports composition: routines can call other routines up to 3 levels deep. At `MAX_ROUTINE_DEPTH` (3), the `useRoutine` tool is omitted from the tool set entirely.
- **Purity gate**: When the surrounding `ToolContext.callingContext === "watcher"`, `useRoutine` rejects routines with `purity: "action"` before executing them. Watchers can only compose with routines marked `purity: "read"`. Additionally, when a routine _runs_ under `callingContext: "watcher"`, the routine executor swaps `allTools` for `routineToolsUnderWatcher` — a read-only tool subset that excludes `sendEmail`, `rememberFact`, `manageReminders`, `sendPhoto`, `sendVoice`, `manageRoutines`, `manageWatchers`, and the mutating browse actions. This makes the watcher invariant transitive: a read-purity routine spawned by a watcher cannot mutate external state through its own tool palette, even if its prompt instructs it to. Main chat and routine-executor contexts (`callingContext: "main"`, the default) are unrestricted.

**Routine Execution**: Routines run via `generateText` with a lean context (executor identity + datetime + parameter injection — no soul or conversational instructions). Step limits vary by trigger: cron = 20 steps at temp 0.4, manual (depth 0) = 10 steps at temp 0.5, composed (depth > 0) = 5 steps at temp 0.4. A separate execution log (`RoutineLog`) tracks each run's status, trigger type, parameters, parent log (for composed calls), and timing. The scheduler polls every 60s, skips routines that are already running, and resets stale locks on startup.

**Architecture**: Executor service in `apps/bot/src/services/routine-executor.ts`, scheduler in `apps/bot/src/scheduler/routines.ts`, tools in `apps/bot/src/ai/tools/routines.ts` (`createManageRoutinesTool`, `createSearchRoutinesTool`, `createUseRoutineTool`). DB models (`Routine`, `RoutineLog`) in `packages/db/src/models/routine.ts`. See [routines.md](routines.md) for full documentation.

### manageWatchers

- **Purpose**: Manage watchers — scheduled detection jobs that observe a target, compare against `lastState`, and notify only when a user-defined condition is met
- **Parameters**: `{ action: "create"|"list"|"update"|"delete"|"enable"|"disable", watcherId?, name?, description?, prompt?, cronSchedule?, expiresAt? }`
- **Returns**: `{ success, watcherId? }` or `{ success, watchers? }` or `{ success: false, reason }`
- **Behavior**: Creates, lists, updates, deletes, enables, or disables watchers. Cron expression and `expiresAt` are validated; `expiresAt` defaults to 30 days from creation. Names are unique per chat among non-archived watchers (partial unique index, so a name can be reused after archive). Available in main chat and inside routine executors — but explicitly **omitted from `watcherTools`** so watchers cannot author watchers.

### reportWatcherResult (watcherTools only)

- **Purpose**: Terminating tool the watcher executor parses to extract the structured detection result
- **Parameters**: `{ triggered: boolean, summary: string, newState: string }`
- **Returns**: `{ ok: true }`
- **Behavior**: The executor reads the call's `input` (not the return value) from `result.steps`, persists `summary`/`newState` to the WatcherLog, updates `watcher.lastState`, and sends `summary` to the user only when `triggered === true`. Used as one of two `stopWhen` conditions on `generateText` (alongside `stepCountIs(10)`) so the LLM halts immediately after reporting.

**Watcher Execution**: Watchers run via `generateText` with a lean context (detector identity + datetime + last state + watcher prompt — no soul). Stop conditions: `stepCountIs(10)` or `hasToolCall("reportWatcherResult")`, whichever fires first. Temperature 0.3 for determinism. Token usage is tracked under category `"watcher"`. The scheduler polls every 60s, archives expired watchers, and resets stale locks on startup. Notifications use `sendSegmented` and only fire when `triggered === true`.

**Architecture**: Executor service in `apps/bot/src/services/watcher-executor.ts`, scheduler in `apps/bot/src/scheduler/watchers.ts`, tools in `apps/bot/src/ai/tools/watchers.ts` (`createManageWatchersTool`, `reportWatcherResult`). DB models (`Watcher`, `WatcherLog`) in `packages/db/src/models/watcher.ts`. See [watchers.md](watchers.md) for full documentation.

## Image Generation

Implemented in `apps/bot/src/context/generator.ts`. Uses the Vercel AI SDK `generateImage()` function with a configurable provider/model via `IMAGE_GENERATION_MODEL`.

### Supported Providers

| Provider | Example Models                                                                           | Max Refs | Notes                                   |
| -------- | ---------------------------------------------------------------------------------------- | -------- | --------------------------------------- |
| `xai`    | `grok-imagine-image`                                                                     | 3        | Original provider                       |
| `google` | `gemini-2.5-flash-image`, `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview` | 11–14    | Object fidelity + character consistency |
| `openai` | `gpt-image-1`, `gpt-image-1-mini`                                                        | 16       | Mask optional                           |

Set via env: `IMAGE_GENERATION_MODEL=xai/grok-imagine-image` (compound `provider/model` format).

### Reference Images

Loaded at startup from `context/references/`:

```
context/references/
├── face/       → Face reference photos (LLM selects best match)
├── body/       → Body reference photos (LLM selects best match)
└── outfits/    → Outfit options (LLM selects best match)
```

Images are converted to base64 and passed to `generateImage()` via `prompt.images`. All three reference types use `getModel(ModelTier.Fast)` to pick the best match for the scene — considering expression/angle for faces, pose/framing for bodies, and clothing fit for outfits. If only one reference exists in a category it's used directly; selection is skipped.

### Settings

Loaded from `context/settings/` — plain-text `.md` files describing locations (bedroom, kitchen, etc.). The LLM selects the best match for the scene description.

### Generation Flow

```
sendPhoto tool invoked with description
    │
    ├─ 1. Select references (all via the generic selectReference helper, in parallel):
    │      ├─ Face reference (LLM picks best expression/angle)
    │      ├─ Body reference (LLM picks best pose/framing)
    │      └─ Outfit (LLM picks best match from available options)
    │
    ├─ 2. LLM selects setting/location if relevant
    │
    ├─ 3. Assemble prompt: imagePrefix (loaded from context/image-prefix.md)
    │      + "Scene: <description>" + outfit/setting instructions
    │
    ├─ 4. AI SDK generateImage():
    │      ├─ Model: getImageModel() (from IMAGE_GENERATION_MODEL env)
    │      ├─ prompt: { text, images } (with refs) or plain string (without)
    │      └─ aspectRatio from tool parameters
    │
    ├─ 5. result.image.uint8Array → Buffer
    │
    └─ 6. adapter.sendPhotoBuffer(chatId, buffer, caption)
```

## TTS / Voice Generation

Implemented in `apps/bot/src/tts/generator.ts` with provider modules in `apps/bot/src/tts/providers/`. Uses the Vercel AI SDK `experimental_generateSpeech()` function with a configurable provider/model via `TTS_PROVIDER`.

### Supported Providers

| Provider     | Example Models                                                     | Output Format | Notes                                                 |
| ------------ | ------------------------------------------------------------------ | ------------- | ----------------------------------------------------- |
| `elevenlabs` | `eleven_flash_v2_5`, `eleven_multilingual_v2`, `eleven_turbo_v2_5` | MP3 (44.1kHz) | Best quality, voice cloning, via `@ai-sdk/elevenlabs` |

Set via env: `TTS_PROVIDER=elevenlabs/eleven_flash_v2_5` (compound `provider/model` format). Currently ElevenLabs is the only registered provider.

### Generation Flow

```
sendVoice tool invoked with { text }
    │
    ├─ 1. generateVoice({ text }) in tts/generator.ts
    │      ├─ Parse TTS_PROVIDER → { provider, modelId }
    │      ├─ Dispatch to provider module (elevenlabs.ts)
    │      ├─ Call experimental_generateSpeech() with voice from TTS_VOICE_ID
    │      └─ Return { buffer, mediaType }
    │
    ├─ 2. adapter.sendVoiceBuffer(chatId, buffer)
    │      └─ Grammy bot.api.sendVoice() → Telegram voice message
    │
    └─ 3. trackTtsGeneration(model, provider, charCount)
```

### Adapter Pattern

The TTS system uses the same provider/model compound format as image generation. Currently `apps/bot/src/tts/providers/` contains only `elevenlabs.ts`. Adding a new provider requires:

1. Create `apps/bot/src/tts/providers/<name>.ts` exporting `generateWith<Name>(text, modelId)`
2. Add a `case` in `generator.ts` dispatch switch
3. Add pricing entry in `token-tracker.ts` `TTS_GENERATION_PRICING`
4. Add API key validation in `packages/shared/src/config.ts` `validateConfig()`

## Response Handling

Implemented in `apps/bot/src/ai/response.ts`.

### Response Extraction

- `extractResponseText(steps)` — walks LLM steps backward to find the last step with text output
- `collectToolCalls(steps)` — flattens all tool calls + results across all steps into `{ toolName, args, result }[]`. Results are matched by `toolCallId` for correct correlation when the same tool is called multiple times.
- `wasPhotoSent(steps)` — checks if any step's sendPhoto tool returned `sent: true`

### Segmented Sending

`sendSegmented(adapter, chatId, text)`:

- Splits response text on double-newlines (`\n\n`)
- Sends each segment as a separate message
- Skipped entirely if `wasPhotoSent()` is true (photo already delivered)

### Step Logging

`logSteps(steps)` logs each generation step at DEBUG level with tool names, text preview, and finish reason.

## Generation Parameters

The main `generateText()` call in `apps/bot/src/ai/generate.ts` uses:

| Parameter     | Value                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`       | From `getModel()` (provider-dependent)                                                                                                               |
| `system`      | Assembled system prompt (with sessionId)                                                                                                             |
| `messages`    | Last 40 messages from active session (reconstructed)                                                                                                 |
| `tools`       | `allTools(ctx)` — full conversational tool surface                                                                                                   |
| `stopWhen`    | `stepCountIs(5)`                                                                                                                                     |
| `temperature` | 0.7                                                                                                                                                  |
| `abortSignal` | `AbortSignal.timeout(120_000)` — 2 minute timeout. Fast-tier reference/setting selection calls in `context/generator.ts` use a separate 30s timeout. |

## Speech-to-Text (STT)

When `STT_PROVIDER` is set, inbound voice notes (Telegram `message:voice` / `message:audio`, iMessage audio attachments) are transcribed before reaching the LLM. The user message arrives in conversation history as `[voice] <transcript>` so Mashiro knows the user spoke.

Implementation lives at `apps/bot/src/stt/` mirroring the TTS module shape. A single OpenAI-compatible provider covers both cloud (`api.openai.com`) and local (whisper.cpp HTTP server) — only `STT_BASE_URL` differs. The transcribe call uses Vercel AI SDK's `experimental_transcribe` from the `ai` package with `createOpenAI({ baseURL })` from `@ai-sdk/openai`. 25 MB / 30-min cap; oversized audio surfaces as `[voice note too long to transcribe]` placeholder. See [voice.md](voice.md) for setup.

The original audio is persisted to a separate GridFS bucket (`audio.files` / `audio.chunks`) so a future multimodal model can re-feed without a re-record. The `IMessage` schema gained `audioRef`, `audioMimeType`, `audioDurationSeconds` fields alongside the existing `imageRef` shape.

## Token Usage Observability

All LLM call sites track token usage via `apps/bot/src/ai/token-tracker.ts`. Each call logs prompt/completion tokens and estimated cost via Pino at **`debug`** level (silent at the default `info` level — the data is persisted regardless), then persists to the `TokenUsage` MongoDB collection (fire-and-forget). The `/usage` dashboard reads `TokenUsage`, not the logs.

### Categories

| Category            | Call Sites                                                           |
| ------------------- | -------------------------------------------------------------------- |
| `conversation`      | Main `generateText` in `generate.ts`                                 |
| `proactive`         | Proactive message generation in `proactive.ts`                       |
| `routine`           | Routine execution in `routine-executor.ts`                           |
| `curation`          | All curator calls (summary, facts, follow-ups, weekly/monthly merge) |
| `image-selection`   | Reference image selection (outfit, face, body, setting)              |
| `image-generation`  | Image generation via AI SDK (fixed cost per call, model-dependent)   |
| `tts-generation`    | TTS voice generation (cost per 1K characters, model-dependent)       |
| `stt-transcription` | STT transcription of inbound voice (cost per minute, $0 for local)   |

### Pricing

Cost estimation uses a per-model lookup table (`MODEL_PRICING` in `token-tracker.ts`). Image generation uses a fixed cost per call. The `getModelName(tier)` helper in `provider.ts` resolves the string model ID without creating a provider instance.

### Dashboard

The `/usage` page displays cost breakdowns by category, daily trends, and summary stats (today/week/month). Queries in `apps/dashboard/src/lib/queries/usage.ts`. The `TokenUsage` model and aggregation helpers (`getUsageSummary`, `getDailyUsage`, `getTotalCost`) are exported from `@kokoro/db`.
