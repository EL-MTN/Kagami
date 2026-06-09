# AI Layer

The AI layer handles LLM integration, prompt assembly, tool orchestration, image generation, and response delivery. All code lives under `apps/bot/src/ai/` and `apps/bot/src/context/`.

## Provider Configuration

Defined in `apps/bot/src/ai/provider.ts`. Chat goes through the shared
`@kagami/llm` gateway (`createInference`, `kind: "native"`) — the gateway owns
provider/key construction, retry, same-tier fallback, and span/usage emission;
`provider.ts` stays the caller-side **tier policy** (the `ModelTier` → model-id
map). Image / TTS / STT still use the Vercel AI SDK directly.

| Env Variable                 | Description                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_KIND`                   | `"native"` (only supported value for Kokoro chat; default)                                                                                                                                                    |
| `LLM_PROVIDER`               | `"anthropic"` (default), `"openai"`, or `"xai"`                                                                                                                                                               |
| `LLM_MODEL`                  | Default-tier model id (default: `"claude-sonnet-4-6"`; recommended xAI model: `grok-4-1-fast-non-reasoning`)                                                                                                  |
| `LLM_MODEL_FAST`             | Optional override for the `Fast` tier (unset → per-provider default below)                                                                                                                                    |
| `LLM_MODEL_SMART`            | Optional override for the `Smart` tier (unset → per-provider default below)                                                                                                                                   |
| `ANTHROPIC_API_KEY`          | Required if provider is `anthropic` (validated at startup)                                                                                                                                                    |
| `OPENAI_API_KEY`             | Required if provider is `openai` (validated at startup)                                                                                                                                                       |
| `XAI_API_KEY`                | Required if provider is `xai` (validated at startup)                                                                                                                                                          |
| `IMAGE_GENERATION_MODEL`     | Image model in `provider/model` format (e.g., `xai/grok-imagine-image`, `google/gemini-2.5-flash-image`, `openai/gpt-image-1`). Enables `sendPhoto` tool when set.                                            |
| `TTS_PROVIDER`               | TTS model in `provider/model` format (e.g., `elevenlabs/eleven_flash_v2_5`). Enables `sendVoice` tool when set.                                                                                               |
| `TTS_VOICE_ID`               | ElevenLabs voice identifier                                                                                                                                                                                   |
| `ELEVENLABS_API_KEY`         | Required when `TTS_PROVIDER` is set                                                                                                                                                                           |
| `GOOGLE_API_KEY`             | Required for embedding generation (Google Gemini `gemini-embedding-001`)                                                                                                                                      |
| `EMBEDDING_MODEL`            | Embedding model name (default: `"gemini-embedding-001"`)                                                                                                                                                      |
| `KIZUNA_URL`                 | Kizuna API base URL for CRM tools — reads call directly, writes are confirmation-gated (default: `https://api.kizuna.localhost`)                                                                              |
| `EXECUTE_CODE_ENABLED`       | Enables the `executeCode` tool (Docker-sandboxed Python/Node, tap-to-approve with full code in the bubble). Tunables: `EXECUTE_CODE_{PYTHON,NODE}_IMAGE`, `EXECUTE_CODE_TIMEOUT_MS`, `EXECUTE_CODE_MEMORY_MB` |
| `GOOGLE_MAPS_API_KEY`        | Google Maps Geocoding API key (optional; geocoding degrades to raw coordinates without it)                                                                                                                    |
| `LOCATION_CONTEXT_MAX_AGE_H` | Max age in hours for location data to appear in LLM context (default: `12`)                                                                                                                                   |

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

Implemented in `apps/bot/src/ai/context-assembler.ts`. The system prompt carries no facts — long-term memory is on-demand via the `searchMemory` tool, not pre-loaded. The shell is small and largely static; only routines, skills, pending approvals, location, and (for proactive) reminders pull from MongoDB.

```
assembleSystemPrompt(chatId)
    │
    ├─ 1. Soul                       ← apps/bot/context/soul.md (file)
    ├─ 2. Current Mood               ← prompts.ts moodForTimeOfDay() — derived from time-of-day bucket
    ├─ 3. Datetime context           ← current time + time-of-day label
    ├─ 4. Tool behavior              ← apps/bot/context/instructions/tool-behavior.md
    ├─ 5. Maid service               ← apps/bot/context/instructions/maid-service.md (conditional on KAO_URL — Google access via Kao)
    ├─ 6. Web search                 ← apps/bot/context/instructions/web-search.md (conditional on BRAVE_SEARCH_API_KEY)
    ├─ 7. Browser                    ← apps/bot/context/instructions/browser.md (always)
    ├─ 8. Code execution             ← apps/bot/context/instructions/execute-code.md (conditional on EXECUTE_CODE_ENABLED)
    ├─ 9. Routine behavior           ← apps/bot/context/instructions/routines.md (always)
    ├─ 10. Skill behavior            ← apps/bot/context/instructions/skills.md (always)
    ├─ 11. Proposal behavior         ← routine-proposals.md + routine-refinement.md + skill-proposals.md (conversational only)
    ├─ 12. Routine context           ← listRoutinesForChat → enabled routine names (Mongo)
    ├─ 13. Skill context             ← listSkillsForChat → enabled skill catalog (Mongo)
    ├─ 14. Pending approvals         ← listPendingConfirmations (Mongo)
    ├─ 15. Location context          ← last known location if within LOCATION_CONTEXT_MAX_AGE_H (Mongo, always)
    └─ 16. Response format           ← apps/bot/context/instructions/response-format.md

    All parts joined with "\n\n---\n\n"

assembleProactiveSystemPrompt(chatId)
    │
    ├─ shell (1–10 above; proposal behavior omitted)
    ├─ Active reminders              ← pending + recently fired (Mongo)
    ├─ Pending approvals             ← (Mongo)
    ├─ Location context              ← (Mongo, conditional)
    └─ Proactive message             ← apps/bot/context/instructions/proactive-message.md
```

Long-term memory (facts, prior conversations, milestones) is **not** pre-loaded into the prompt. The LLM calls `searchMemory(query)` when it needs context — the tool forwards to Kioku's hybrid retrieval (`@kokoro/memory.recall()` → `POST /recall`). See [memory.md](memory.md) for the full read/write paths.

The persona (`soul.md`) and operational instructions (`instructions/*.md`) are all file-based under `apps/bot/context/`. They are read on-demand and cached in-process by `(absolute path, mtime)` — edits to any of those files are picked up on the next turn without a restart. If an expected instruction file is missing on disk, `readInstruction()` logs a one-time warning per path and returns `null`; the caller skips that section so the assembled prompt remains well-formed. `prompts.ts` itself remains in code, holding `DATETIME_CONTEXT` (templated against `config.TIMEZONE`) and `moodForTimeOfDay()` (5-bucket lookup mirroring the time-of-day buckets). The conversational pipeline above is otherwise either Markdown or pulled from Mongo at assembly time. Note that the routine and watcher executors (see Routine and Watcher Execution below) build their own lean system prompts entirely in code — `ROUTINE_EXECUTOR_IDENTITY` / `WATCHER_EXECUTOR_IDENTITY` plus a templated report-mode instruction live as inline strings in `routine-executor.ts` / `watcher-executor.ts` and are not Markdown-backed.

### Datetime Context

Time awareness is **split by how often each piece changes**, so the precise clock never busts the provider's prompt cache (the cache is a prefix match; render order is `tools → system → messages`, so a per-message value anywhere in the system prefix invalidates the whole downstream prefix every turn). All helpers live in `apps/bot/src/ai/prompts.ts` and template against `config.TIMEZONE`:

- **`DATE_CONTEXT(now)`** — goes in the **frozen system-prompt prefix** (`assemblePromptShell`). Date + weekday + timezone + time-of-day bucket only, **no clock time** — so the prefix changes at most once/day (plus the few time-of-day boundary crossings), not per message. Mirrors how Claude Code keeps only the date in its system prompt.
- **`currentTimeContext(now)`** — the precise minute-level clock + IANA zone + ISO-8601 offset (e.g. `Current time: 5:34 PM PDT (2026-06-05T17:34:00-07:00)`), injected as a **trailing `role:"system"` message** in `generate.ts` (`allowSystemInMessages: true` — it's server-generated, not user input). The tail is new every turn anyway, so this adds zero cache cost while keeping minute-accurate answers to "what time is it". `isoWithOffset(now, tz)` builds the offset (DST-aware via `Intl`) and is shared with the `getCurrentTime` tool.
- **`DATETIME_CONTEXT(now)`** — the original combined date+time string, **retained** for the lean, one-shot, non-conversational paths that have no message tail and rebuild their prefix each run anyway: the routine executor, watcher executor, and `delegate` sub-tasks.
- **`getCurrentTime` tool** (`tools/time.ts`) — a fully-local (no MCP/network) on-demand read for the two cases ambient context can't cover: a fresh read deep into a long task (the tail time is stamped at turn start and can drift), and the time in a **different** timezone (`timezone` IANA param). Pure read — registered in both `allTools` and the watcher read-only subset.

The time-of-day buckets (`timeOfDayFor`, driving `moodForTimeOfDay`):

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

Defined in `apps/bot/src/ai/tools/`. Tool files are consolidated by domain: `media.ts` (sendPhoto, sendVoice), `email.ts` (checkEmail, sendEmail), `calendar.ts` (manageCalendar, manageReminders), `confirmations.ts` (requestConfirmation, cancelConfirmation), `memory.ts` (searchMemory, rememberFact), `crm.ts` (read: findPeople, getPersonContext, recentInteractions, listMyFollowups; write: logInteraction, createFollowup, resolveFollowup, updatePerson — writes must be wrapped in `requestConfirmation`), `routines.ts` (manageRoutines, searchRoutines, useRoutine), `skills.ts` (searchSkills, readSkill, proposeSkill), `delegate.ts` (delegate — parallel read-only fan-out), `watchers.ts` (manageWatchers, reportWatcherResult), `browse.ts`, `web-search.ts`, `execute-code.ts` (executeCode — sandboxed code execution, conditional on `EXECUTE_CODE_ENABLED`), and `time.ts` (getCurrentTime — local, no MCP). The barrel `index.ts` exports `allTools(ctx)` / `watcherTools(ctx)` / `routineToolsUnderWatcher(ctx)`. All tools are passed to `generateText()` and the LLM can invoke them across up to 5 steps.

### Tool Context

```typescript
interface ToolContext {
  chatId: string;
  adapter: PlatformAdapter;
  sessionId: string;
  userId?: string; // user driving the turn; absent for cron-triggered routines
  routineDepth?: number; // Current routine nesting depth (0 = top-level)
  routineLogId?: string; // RoutineLog id of the running routine; forwarded as parentLogId by useRoutine/delegate
  callingContext?: "main" | "watcher"; // gates routine purity; defaults to "main"
}

allTools(ctx) → { rememberFact, searchMemory, searchSkills, readSkill, getCurrentTime, executeCode?, findPeople?, getPersonContext?, recentInteractions?, listMyFollowups?, logInteraction?, createFollowup?, resolveFollowup?, updatePerson?, sendPhoto?, sendVoice?, checkEmail?, sendEmail?, manageCalendar?, manageReminders?, webSearch?, browse?, requestConfirmation?, cancelConfirmation?, manageRoutines, searchRoutines, useRoutine?, delegate?, manageWatchers, proposeSkill? }

watcherTools(ctx) → { searchMemory, searchSkills, readSkill, findPeople?, getPersonContext?, recentInteractions?, listMyFollowups?, reportWatcherResult, checkEmail?, listCalendarEvents?, webSearch?, browse? (read-only), useRoutine? }
```

Two distinct tool sets are assembled depending on the calling context:

- **`allTools(ctx)`** — full surface available to Mashiro in conversation and inside routine executors. Includes side-effecting tools (`sendEmail`, `rememberFact`, `manageReminders`, `sendPhoto`, etc.) plus CRM lookup tools (always), routine tools, and skill read tools. `proposeSkill` is added only on live conversational turns.
- **`watcherTools(ctx)`** — read-only subset for watcher executor ticks (`apps/bot/src/services/watcher-executor.ts`). Watchers observe; they never mutate external state. `searchMemory`, `searchSkills`, `readSkill`, and the Kizuna CRM **read** tools are included; `rememberFact`, `proposeSkill`, and the Kizuna CRM **write** tools (`logInteraction`, `createFollowup`, `resolveFollowup`, `updatePerson`) are excluded. The browse tool is the `createReadOnlyBrowseTool()` variant, which restricts actions to `search`/`visit`/`extract` and excludes `screenshot` (sends a photo), `act` (mutates page state), and `login`. The calendar variant is `createManageCalendarTool({ mode: "readOnly" })`. `manageWatchers` is also excluded — watchers cannot create watchers.

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

### CRM tools (always registered)

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

### requestConfirmation (always registered)

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

### browse (always registered)

- **Purpose**: Browse the web — visit pages, extract data, interact with elements, or take screenshots. (Autonomous multi-step browsing is **not** an inline action — it can't fit the per-action timeout; it lives in the confirmation-gated `browseAgent`.) When `BRAVE_SEARCH_API_KEY` is also set, the `search` action is dropped from the action enum so the LLM uses `webSearch` for lookups instead.
- **Parameters**: `{ action: "search"?|"visit"|"extract"|"act"|"screenshot"|"login", query?, url?, instruction? }`
- **Returns**: Varies by action. Always includes `{ success: boolean }`.
- **Behavior**: Uses Stagehand (LLM-driven browser automation on accessibility tree). Supports two environments controlled by `BROWSER_ENV`: `local` runs a singleton Chromium instance with a persistent user profile, `cloud` delegates to Browserbase (requires `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`). Lazy-initialized on first call, auto-shuts down after 5 minutes idle. Every inline action is wrapped in `withBrowserLock` with a **60 s** wall-clock timeout — deliberately below the conversational turn budget (`generate.ts` `LLM_TIMEOUT_MS` = 120 s) so a slow browse fails fast as a `{success:false}` tool result the LLM can answer around, rather than the turn-level abort killing the whole turn. On timeout the singleton is reset so the next call re-inits. Long autonomous runs don't belong inline — they go through the confirmation-gated `browseAgent` (`services/gated-actions.ts`), which dispatches outside the turn with its own 10-min budget.

| Action       | Required param | What it does                                                                                | Stagehand method                            |
| ------------ | -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `search`     | `query`        | DuckDuckGo search → structured results (fallback only when `BRAVE_SEARCH_API_KEY` is unset) | `page.goto()` + `extract()` with Zod schema |
| `visit`      | `url`          | Navigate + extract readable text (truncated 4000 chars)                                     | `page.goto()` + `page.evaluate(innerText)`  |
| `extract`    | `instruction`  | Structured extraction from current page                                                     | `stagehand.extract(instruction)`            |
| `act`        | `instruction`  | Interact with page (click, type, scroll)                                                    | `stagehand.act(instruction)`                |
| `screenshot` | —              | Capture page → send as photo                                                                | `page.screenshot()`                         |
| `login`      | `url`          | Opens login page for manual credential entry                                                | `page.goto()` (no browser release)          |

Autonomous multi-step browsing (`stagehand.agent().execute()`, up to 25 steps) is the separate confirmation-gated `browseAgent` action, dispatched outside the conversational turn — see `services/gated-actions.ts`.

**Architecture**: Two independent LLM streams — Kokoro's main loop (Sonnet) decides _what_ to browse, Stagehand's internal calls (Haiku/Fast tier) decide _how_ to navigate. Configured via `BROWSER_ENV` (`local`/`cloud`), `BROWSER_DATA_DIR`, `BROWSER_HEADLESS`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` env vars. Browser service in `apps/bot/src/services/browser.ts`, tool in `apps/bot/src/ai/tools/browse.ts`.

**Observability (Kansoku)**: Each action runs inside `runWithSpan(\`browse.<action>\`)`and browser init inside`runWithSpan("browser.init")`, so a browse turn renders as a real waterfall (per-action durations, nested under the conversation trace) in Kansoku. Stagehand's own steps are bridged into the `@kokoro/shared`logger via its`logger(line)` hook (`stagehandLogger`in`browser.ts`): each `LogLine`ships as a`browser: …`log line tagged with its`category` (`init`/`extraction`/`act`/`aisdk`/…) and auto-correlated to the active trace/span. Stagehand `verbose`is gated on log level —`1`(step-level) normally,`2`(full prompts/responses/DOM, the`aisdk`lines) when`LOG_LEVEL=debug`— and`auxiliary`values are truncated (~4 KB) so a DOM dump can't bloat ingest. Net: to deep-debug a browse turn, **start** the bot with `LOG_LEVEL=debug` and open its trace in Kansoku. (`STAGEHAND_VERBOSE`is fixed at the first browser init from the process-level`LOG_LEVEL`, so this is start-time, not hot-toggleable.) The confirmation-gated `browseAgent` path (`services/gated-actions.ts`) is spanned the same way (`browse.agent`). **Caution:** at `verbose: 2`the`aisdk`lines carry the full LLM prompt/response and page content, and`@kokoro/logger`does no secret/PII redaction (local-trust only) — so a`login`/`agent`flow run under`LOG_LEVEL=debug`can ship typed credentials or page secrets to Kansoku. Use debug verbosity deliberately, and treat it as a pre-VPS redaction blocker (see`ARCHITECTURE.md`).

### executeCode (conditional — requires EXECUTE_CODE_ENABLED)

- **Purpose**: Run LLM-written Python or Node scripts for exact computation, data transforms, and programmatic generation — things conversation and browsing can't do reliably.
- **Parameters**: `{ language: "python" | "node", code: string (≤8000 chars), description: string (one sentence for the approval bubble) }`
- **Returns**: `{ pending: true, confirmationId, message }` — the tool **never executes code itself**.
- **Behavior**: Proposal pattern (like `proposeRoutine`, not like `requestConfirmation`): the tool calls `raisePendingConfirmation` directly with the full code as a fenced block in `promptText` (preview capped at 3000 chars), so the user reviews the **program body** before approving. The action name `executeCode` lives in `DISPATCH_ONLY_TOOL_NAMES` — deliberately absent from `requestConfirmation`'s enum, so the model cannot route code execution behind a ≤400-char summary. On approve, `dispatchGatedAction` re-validates the args, then runs the code in an **ephemeral Docker container** via `apps/bot/src/services/code-sandbox.ts`: `--network none`, empty env, `--cap-drop ALL`, `no-new-privileges`, read-only rootfs + 64 MB `/tmp` tmpfs, numeric nobody user, pid/memory/CPU caps, code delivered via stdin (never argv), at most 2 concurrent runs. Non-zero exit, timeout (`EXECUTE_CODE_TIMEOUT_MS`, default 120 s — enforced by a host-side `docker rm -f`, not Node's client-only timeout), and OOM (exit 137 heuristic against the `EXECUTE_CODE_MEMORY_MB` cap) are reported as results the LLM can react to; daemon-down / image-missing surface as friendly `CodeSandboxError` summaries (fail-open — chat continues). Output is stdout+stderr combined, capped at 4000 chars. Startup (`apps/bot/src/index.ts`) sweeps orphaned `kokoro-exec-*` containers and pre-pulls both images (`EXECUTE_CODE_{PYTHON,NODE}_IMAGE`), fire-and-forget.
- **Logging**: the code body is **never logged** — only `{ language, codeLength }` — so secrets pasted into a script can't reach Kansoku. The full code persists only in the `PendingConfirmation` row (24 h TTL). The run is spanned as `code.execute`.
- **Palette**: registered in `allTools` only when `EXECUTE_CODE_ENABLED` is set; deliberately **absent** from `readOnlyToolSubset` / `watcherTools` / `routineToolsUnderWatcher` — execution is a mutation-class capability, so observation runs and delegate sub-tasks never see it. System-prompt rule in `apps/bot/context/instructions/execute-code.md` (loaded only when enabled). See [confirmations.md](confirmations.md#dispatch-only-actions-not-llm-raisable).

### searchSkills / readSkill

- **Purpose**: Discover and load reusable procedural context. Skills guide how Mashiro should work; they do not execute anything.
- **Parameters**: `searchSkills({ query?: string })`, `readSkill({ name: string })`
- **Returns**: `searchSkills` returns a compact enabled-skill catalog (`name`, `description`, `triggers`, `tags`, `source`, `version`); `readSkill` returns the full `body` and increments usage metadata.
- **Behavior**: The system prompt lists only a compact `## Available Skills` catalog. The model calls `searchSkills` for discovery and `readSkill` before applying detailed guidance. Both tools are pure reads and are available in `allTools`, `watcherTools`, and `routineToolsUnderWatcher`.

### proposeSkill (live conversational turns only)

- **Purpose**: Let the conversational model offer to save reusable procedural guidance — preferences, heuristics, style, project rules, or operating procedure — as a skill. Skills are context, not automation.
- **Parameters**: `{ name, description, body, triggers?, tags? }`
- **Returns**: `{ proposed: true, confirmationId }` or `{ proposed: false, reason }`
- **Behavior**: Does not create anything directly. It computes a signature from normalized name + body hash, runs the `SkillProposalDecision` anti-nag guard plus the shared one-pending guard (**any** pending confirmation suppresses — a gated action like `sendEmail` just as much as another proposal, because iMessage resolves a bare YES/NO only when exactly one confirmation is pending), then raises a tap-to-approve bubble whose approved action is dispatch-only `createSkill`. On approve, the dispatcher creates an enabled `source: "distilled"` skill; on deny/cancel it records a declined skill proposal.
- **Offered on live conversational turns only**: `allTools` registers `proposeSkill` only when `ToolContext.conversational === true`, matching `proposeRoutine`. Routines, proactive turns, watchers, and watcher-safe routines can read skills but cannot author them.
- **`createSkill` is dispatch-only**: absent from `GATED_TOOL_NAMES`, so the model cannot raise it through `requestConfirmation` and bypass the proposal guard.

**Architecture**: Tool in `apps/bot/src/ai/tools/skills.ts`; proposal helper in `apps/bot/src/ai/tools/skill-proposal-tools.ts`; dispatch case and decline recording in `apps/bot/src/services/gated-actions.ts`; DB models in `packages/db/src/models/skill.ts` and `packages/db/src/models/skill-proposal.ts`; prompt rules in `apps/bot/context/instructions/skills.md` and `apps/bot/context/instructions/skill-proposals.md`; dashboard in `/skills`. See [skills.md](skills.md).

### searchRoutines

- **Purpose**: Search and discover available routines by keyword
- **Parameters**: `{ query?: string }`
- **Returns**: `{ success: true, count, routines: [{ name, description, parameters, cronSchedule, reportMode }] }` or `{ success: false, reason }`
- **Behavior**: Searches enabled routines for the current chat by matching keywords against routine names and descriptions. Call with no query to list all enabled routines. This is the primary discovery mechanism — the system prompt only lists routine names, so the LLM uses this tool to get full details (parameters, schedules) before invoking a routine.

### manageRoutines

- **Purpose**: Manage reusable routines — named capabilities with optional parameters and optional cron schedules
- **Parameters**: `{ action: "create"|"list"|"update"|"delete"|"enable"|"disable", routineId?, name?, description?, prompt?, parameters?, cronSchedule?, reportMode?, purity? }`. For `update`/`delete`/`enable`/`disable`, `routineId` accepts **either** the routine's ObjectId **or** its unique name — the model is told to use names as routine handles everywhere else (e.g. `useRoutine`), so the tool resolves whichever it's given via `resolveRoutineRef` (guarded id cast → fall back to name lookup) rather than throwing a Mongoose `CastError` on a name.
- **Returns**: `{ success, routineId? }` (a canonical string id, even when the routine was addressed by name) or `{ success, routines? }` or `{ success: false, reason }`
- **Behavior**: Creates, lists, updates, deletes, enables, or disables routines. Routines are named LLM-prompted capabilities stored in the database with typed parameters. Each routine has a `reportMode`: `"always"` sends a summary after every run, `"alert"` only messages when something noteworthy or an error occurs. Each routine also has a `purity` marker: `"read"` (routine only observes — search, summarize, query — and is safe to invoke from a watcher) or `"action"` (routine mutates external state — sends, writes, modifies — and watchers cannot invoke it). `purity` defaults to `"action"` if omitted on create, the conservative choice for backward-compat. Cron expressions are validated. Cron-scheduled routines require all required parameters to have defaults. Routine names are unique per chat (compound index), so a name resolves to exactly one routine. Version number increments on each update.

### useRoutine (conditional — omitted at max depth)

- **Purpose**: Invoke a routine by name with optional parameters
- **Parameters**: `{ routineName: string, parameters?: Record<string, unknown> }`
- **Returns**: `{ success: true, routineName, result }` or `{ success: false, reason }`
- **Behavior**: Looks up routine by name, validates parameters (type checking, required params, defaults), then executes synchronously via `executeRoutine()`. The result is returned to the calling LLM. Supports composition: routines can call other routines up to 3 levels deep. At `MAX_ROUTINE_DEPTH` (3), the `useRoutine` tool is omitted from the tool set entirely.
- **Purity gate**: When the surrounding `ToolContext.callingContext === "watcher"`, `useRoutine` rejects routines with `purity: "action"` before executing them. Watchers can only compose with routines marked `purity: "read"`. Additionally, when a routine _runs_ under `callingContext: "watcher"`, the routine executor swaps `allTools` for `routineToolsUnderWatcher` — a read-only tool subset that excludes `sendEmail`, `rememberFact`, `manageReminders`, `sendPhoto`, `sendVoice`, `manageRoutines`, `manageWatchers`, and the mutating browse actions. This makes the watcher invariant transitive: a read-purity routine spawned by a watcher cannot mutate external state through its own tool palette, even if its prompt instructs it to. Main chat and routine-executor contexts (`callingContext: "main"`, the default) are unrestricted.

**Routine Execution**: Routines run via `generateText` with a lean context (executor identity + datetime + parameter injection — no soul or conversational instructions). Step limits vary by trigger: cron = 20 steps at temp 0.4, manual (depth 0) = 10 steps at temp 0.5, composed (depth > 0) = 5 steps at temp 0.4. A separate execution log (`RoutineLog`) tracks each run's status, trigger type, parameters, parent log (for composed calls), and timing. The scheduler polls every 60s, skips routines that are already running, and resets stale locks on startup. The actual LLM step-loop is the shared `runTaskAgent` core (`apps/bot/src/services/task-agent.ts`) — one `generateText` call over a tool palette, returning text + usage + step count, owning no persistence or messaging. `executeRoutine` wraps it with the `RoutineLog` lifecycle, cron advance, and report delivery; the `delegate` tool (below) reuses the same core for its parallel sub-tasks.

**Architecture**: Execution core in `apps/bot/src/services/task-agent.ts` (`runTaskAgent`), executor service in `apps/bot/src/services/routine-executor.ts`, scheduler in `apps/bot/src/scheduler/routines.ts`, tools in `apps/bot/src/ai/tools/routines.ts` (`createManageRoutinesTool`, `createSearchRoutinesTool`, `createUseRoutineTool`). DB models (`Routine`, `RoutineLog`) in `packages/db/src/models/routine.ts`. See [routines.md](routines.md) for full documentation.

### delegate (conditional — omitted at max depth)

- **Purpose**: Fan out several **independent, read-only** sub-tasks in parallel and collect their results — the parallel-gathering counterpart to calling tools or `useRoutine` serially. Writes stay with the caller: fan out the gathering, then act on the results yourself, sequentially and gated.
- **Parameters**: `{ subtasks: Array<{ label: string } & ({ prompt: string } | { routineName: string, parameters? })> }` — between **2 and 6** sub-tasks (`MAX_SUBTASKS`). Each sub-task carries **exactly one** of `prompt` (inline instructions) or `routineName` (an existing read-purity routine); a Zod `.refine` enforces the XOR.
- **Returns**: `{ success: true, results: Array<{ label, success: true, result } | { label, success: false, error }> }`, in input order.
- **Behavior**: Two branch kinds, both read-only and both wrapped in `runWithSpan("delegate.subtask", …)` (so the fan-out renders as a parallel waterfall in Kansoku):
  - **Inline (`prompt`)** — runs as its own `runTaskAgent` call (5 steps, temp 0.4) on the **read-only palette** (`readOnlyToolSubset`, the same subset the watcher invariant uses: web/browser search, memory recall, email/calendar reads, CRM reads; no sends, writes, or confirmations). The palette is injected from `index.ts` at registration, so `delegate.ts` never imports back into the barrel. Usage tracked under the `delegate` category.
  - **Routine-backed (`routineName`)** — mirrors `useRoutine`'s lookup + parameter validation (via the shared `./routine-params` leaf), but **rejects `action`-purity routines** (delegate only fans out gathering) and runs the routine via `executeRoutine` with `trigger: "routine"` + `callingContext: "watcher"`, so even a `read` routine runs on the transitive read-only palette and never delivers its own report. It forwards `ctx.routineLogId` as the spawned run's `parentLogId`, so a fan-out issued from inside a routine shows up as nested child runs in the dashboard's run tree, and passes `rethrow: true` so a routine that fails mid-run surfaces as a failed branch (`{ success: false }`) rather than an `"Error: …"` string masquerading as a successful gather. Usage tracked under the routine executor's own `routine` category.
  - Sub-tasks run one nesting level deeper (`routineDepth + 1`) and, because neither branch exposes `delegate`, **cannot fan out further** — the tree can never deepen past a single fan-out level. Branches run behind a concurrency cap of `SUBTASK_CONCURRENCY = 4` in-flight via `mapLimit`; one branch failing is isolated (`{ success: false, error }`) and never aborts its siblings.
- **Depth gate**: registered in `allTools` only when `routineDepth < MAX_ROUTINE_DEPTH` (same bound as `useRoutine`); deliberately **absent from `watcherTools` / `routineToolsUnderWatcher`** — observation runs stay single-purpose and never fan out.

**Architecture**: Tool in `apps/bot/src/ai/tools/delegate.ts` (`createDelegateTool`), registered in `apps/bot/src/ai/tools/index.ts` with `readOnlyToolSubset` as the injected sub-task palette builder. Shares the `runTaskAgent` core (`apps/bot/src/services/task-agent.ts`) for inline branches and `executeRoutine` for routine-backed branches; routine parameter coercion/validation lives in the `apps/bot/src/ai/tools/routine-params.ts` leaf (shared with `useRoutine`). System-prompt rule in `apps/bot/context/instructions/delegate.md`.

### proposeRoutine (live conversational turns only)

- **Purpose**: Let the conversational model **offer** to save a just-finished, repeatable multi-step task as a reusable routine — human-approved via the confirmation rail, never autonomous. The on-brand, gated version of "skills that grow with you."
- **Parameters**: `{ name, description, prompt, parameters? }` (the generalized routine draft — the model abstracts the concrete run into a reusable prompt + typed parameters for the parts that varied)
- **Returns**: `{ proposed: true, confirmationId }` or `{ proposed: false, reason }` (suppressed by the guard)
- **Behavior**: Does **not** create anything. It computes a `signature` (normalized name + short prompt hash), runs a **durable, code-side anti-nag guard**, then raises a tap-to-approve bubble whose approved action is the dispatch-only `createRoutine`. The bubble shows the **full routine prompt** (not a one-line summary), labeled on-demand / read-only, so the user reviews exactly what they're approving. On approve, the confirmation callback dispatches `createRoutine`, which creates the routine with hardcoded safe defaults — `cronSchedule: null`, `purity: "read"`, `reportMode: "always"`, `enabled: true` — and records an `accepted`. On deny/cancel, the platform callback records a `declined`.
- **Anti-nag guard** (both checks run before any bubble): (1) `isRecentlyDeclined(chatId, signature)` — a durable `RoutineProposalDecision` keyed by `(chatId, signature)` with an **escalating cooldown** (first decline quiet for `ROUTINE_PROPOSAL_COOLDOWN_DAYS` (default 14), repeat declines progressively longer, capped at 365d). This is non-optional because the LLM can't see a prior "no": `assembleMessages` loads only the last 40 messages and sessions reset after 1h idle. (2) one-proposal-at-a-time — suppressed if a `createRoutine` confirmation is already pending (this also protects iMessage's "exactly one pending" YES/NO resolver from stacked bubbles).
- **Offered on live conversational turns only**: `allTools` registers `proposeRoutine` solely when `ToolContext.conversational === true` — set only by the user-initiated turn in `generate.ts`. It's a positive opt-in, so every other `allTools` caller that runs under `callingContext: "main"` (proactive outreach, routine executions) leaves it false and is excluded, on top of the structural exclusion from `watcherTools` / `routineToolsUnderWatcher`. A scheduled/manual/composed routine — or an unprompted proactive message — can never self-author a routine. The system-prompt rule is gated in lockstep (loaded only where the tool is offered).
- **`createRoutine` is dispatch-only**: it is deliberately **absent from `GATED_TOOL_NAMES`** (so it's not in `requestConfirmation`'s enum — the model can't raise it directly and skip the guard) yet still dispatchable through the approval rail. Server-side re-validation at approve time against `createRoutineArgs` (which has no `cronSchedule`/`purity` fields, so a cron'd or action routine can't be smuggled through) is the authoritative gate; the draft args are never trusted (e.g. `chatId` comes from the resolved confirmation row, not the args).

**Architecture**: Tool in `apps/bot/src/ai/tools/routine-proposals.ts` (`createProposeRoutineTool`, `computeProposalSignature`). Shared rail writer `raisePendingConfirmation` + the decline recorder `recordProposalDeclineFromConfirmation` and the `createRoutine` dispatch case live in `apps/bot/src/ai/tools/confirmations.ts` / `apps/bot/src/services/gated-actions.ts`. DB model + helpers (`recordProposalDecision`, `isRecentlyDeclined`) in `packages/db/src/models/routine-proposal.ts`. System-prompt rule in `apps/bot/context/instructions/routine-proposals.md` (loaded by `context-assembler.ts` only on tool-exposing turns). See [confirmations.md](confirmations.md) for the rail.

### proposeRoutineRefinement (live conversational turns only)

- **Purpose**: The other half of the self-improvement loop — let the conversational model **offer to fix an existing routine's prompt** when it has been failing or returning empty results. Human-approved via the same confirmation rail, never autonomous. The "skills self-improve through use" idea, kept on-brand by ending in a tap.
- **The outcome signal**: every routine run writes a `RoutineLog` (`status`/`summary`). `getRoutineHealth(chatId)` (`packages/db/src/models/routine.ts`) aggregates the last N runs per routine into **facts only** — `failedRuns` / `emptyRuns` / `noReportRuns` / `lastError` — excluding `trigger: "routine"` sub-runs and in-flight `running` rows. A blank completion increments `noReportRuns` for **alert-mode** routines (a quiet run, esp. on a manual trigger that gets no sentinel instruction) and `emptyRuns` only for **always-report** routines. The shared `routineNeedsAttention(health)` predicate (also in `routine.ts`) decides whether a routine is underperforming — **`(failed + empty) / realRuns ≥ 0.5` over `realRuns = totalRuns − noReportRuns ≥ 4`** — so no-report runs are excluded from both numerator and denominator. `assembleRoutineContext` annotates the **Available Routines** list with a `⚠ failing — N of last M runs` marker (and the offer-hint) only for routines that predicate flags, and only on conversational turns. One predicate is shared by the chat annotation and the self-review pass so the two surfaces can't disagree; the decision to actually refine still stays with the LLM ("all LLM or no LLM").
- **Parameters**: `{ routineId, newPrompt, rationale, newParameters? }`
- **Returns**: `{ proposed: true, confirmationId }` or `{ proposed: false, reason }`
- **Behavior**: Loads the routine, skips if missing/disabled or **neither** prompt **nor** parameters changed (a parameters-only refinement is allowed), computes a `signature` (`refine:{routineId}#{baseVersion}#{hash(prompt+params)}` — params are in the hash so a parameters-only fix isn't suppressed by a prompt-only decline), runs the **shared anti-nag guard** (durable decline check + one-pending check across **all** confirmations, proposal or not, protecting iMessage's one-tap YES/NO path), then raises a tap-to-approve bubble showing the **current → proposed** prompt diff and the rationale. Approved action is the dispatch-only `updateRoutinePrompt`.
- **`updateRoutinePrompt` is dispatch-only**: absent from `GATED_TOOL_NAMES`, dispatched only through the rail. It re-validates against `updateRoutinePromptArgs` — which omits `purity`/`cronSchedule`/`reportMode`/`enabled`, so **a refinement can only rewrite the prompt (and parameters), never escalate a read routine to action or add a schedule**. The write is an **atomic compare-and-set on version** (`applyRoutineRefinement`): it lands only if the routine is still at `baseVersion`, closing the read-then-write race so a concurrent edit in the ≤2h the bubble sat is rejected (`version_conflict`) rather than clobbered; success bumps `version` (auditable/reversible via the dashboard). The same write **arms loop-closure tracking** — it snapshots the pre-edit prompt into `priorPrompt` and its grade into `preRefineGrade`, stamps `lastRefinedAt`, and resets the (now-ungraded) `lastGrade` — unless `trackForRegression: false` (a revert), which clears those fields instead so the loop can't ping-pong between two prompts. It records **no** `accepted` decision — the prompt now equals the approved one (the equality guard blocks an identical re-proposal) and a version-scoped accept could never match a future signature anyway. Deny/cancel still records a `declined`.
- **Offered on live conversational turns only**: registered alongside `proposeRoutine` under `ctx.conversational` — same structural exclusions (watchers, routine executions, proactive). A routine can't self-edit routines.
  **Architecture**: Tool in `apps/bot/src/ai/tools/routine-refinements.ts` (`createProposeRoutineRefinementTool`, `computeRefinementSignature`, and the shared cores `proposeRefinement` / `proposeRetirement`). `updateRoutinePrompt` dispatch case + the extended `recordProposalDeclineFromConfirmation` in `apps/bot/src/services/gated-actions.ts`. Health helper `getRoutineHealth` + the shared `NO_REPORT_SENTINEL` + the grading/loop-closure helpers (`applyRoutineRefinement`, `recordRoutineGrade`, `clearRefineTracking`, `countRealRunsSince`, `listRoutinesAwaitingPostRefineReview`) in `packages/db/src/models/routine.ts`. Prompt annotation in `apps/bot/src/ai/context-assembler.ts`; system-prompt rule in `apps/bot/context/instructions/routine-refinement.md`. Reuses the `RoutineProposalDecision` store and the confirmation rail.

### Automated self-review pass (always on)

- **Purpose**: The unprompted half of the loop — a periodic audit that catches underperforming routines without waiting for the model to notice one mid-conversation. It can propose a refinement **or** a retirement, both still human-approved.
- **Cadence**: a weekly scheduler (`apps/bot/src/scheduler/routine-review.ts`, started in `index.ts` with the adapter registry; first run ~5 min after boot). Each run is its own root trace.
- **Flow** (`apps/bot/src/services/routine-review.ts`): for every chat with enabled routines (`listChatIdsWithRoutines`), `getRoutineHealth` is computed and a **candidate set** is built from two sources, post-refine first: (1) routines whose last edit has run enough times to judge (`listRoutinesAwaitingPostRefineReview(chatId, MIN_RUNS_TO_REGRADE=3)` — the loop-closure source) and (2) routines the shared `routineNeedsAttention` pre-filter flags as failing (the bad-rate source). Each candidate gets one constrained `generateObject` pass (`ModelTier.Smart`, capped at 4000 chars, tracked under the `routine-review` usage category) that returns **`{ grade: 0–100, action: "refine" | "retire" | "none", newPrompt?, rationale }`** — a real quality grade (success-against-intent **and** whether the output is worth acting on), not just failure counts. A post-refine candidate is graded over only the runs **since `lastRefinedAt`** (`reviewRoutine`'s `since` window) so the grade reflects the new prompt, not pre-edit history. The grade is persisted via `recordRoutineGrade` (chatId-scoped; metadata — no `version` bump). `refine` → `proposeRefinement`; `retire` → `proposeRetirement`; `none` → nothing. The LLM owns both the grade and the decision; the pre-filter only bounds cost.
- **Loop closure (measured refinements)**: a post-refine candidate carries the `preRefineGrade` snapshot from when its last edit was applied. If the fresh grade has dropped at least `REGRESSION_MARGIN` (15) below it, the pass **offers to revert** to `priorPrompt` **and** `priorParameters` (`proposeRefinement` with `trackForRegression: false`, so the revert isn't re-watched) — restoring the full prior state, not a prompt/param hybrid, and turning the open propose→approve loop into a measured one: an edit that made a routine worse gets caught and rolled back, still tap-gated. If the revert is anti-nag/one-pending **suppressed**, the pass falls through to the LLM's own `refine`/`retire` so a still-bad routine isn't left with nothing. **Graduation is conditional**: a routine is `clearRefineTracking`'d (stops being re-graded) only when it **held up** (no regression). A regressed routine stays **armed** so its revert keeps being offered across weekly cycles / an expired bubble / a transiently-suppressed proposal — tracking clears only when the revert actually applies (`applyRoutineRefinement` `trackForRegression:false`) or the user edits the routine. A prompt edit through the generic `updateRoutine` (dashboard PATCH, `manageRoutines update`) also clears grade + tracking, so the review can never propose reverting the user's own edit to a stale `priorPrompt`. An approved forward refinement re-arms tracking fresh.
- **Guardrails**: every proposal passes the shared anti-nag + one-pending-per-chat guard. Two caps bound a run: `MAX_PROPOSALS_PER_RUN = 1` (only one proposal can be pending per chat, so a run raises at most one and stops) and `MAX_REVIEWS_PER_RUN = 6` (bounds **paid LLM reviews** even when reviews return `none` or proposals are anti-nag-suppressed — without it a chat full of chronically-declined routines would pay for a review of every one, every run). The pass is always on — no feature flag.
- **`disableRoutine` is dispatch-only**: retirement **disables** (reversible via `manageRoutines` enable / the dashboard), never deletes (deleting would also wipe `RoutineLog` history). Same atomic version-guarded write (`updateRoutineIfVersion`) as the prompt edit, so a routine edited (perhaps fixed) since the bubble was raised isn't disabled out from under that edit. Records **no** `accepted` decision — a disabled routine is excluded from review anyway, and on re-enable it must be reviewable again (a durable accept would suppress re-proposing retirement for ~90 days even after re-enable).

### Automated skill curation pass (always on)

- **Purpose**: The skill-library counterpart of the routine self-review — a periodic curator that catches stale, low-value, or duplicated skills. Skills are prompt context, so a bad skill quietly degrades every future conversation. The pass proposes **refine** (rewrite content in place), **archive** (disable, reversible), or **merge** (fold duplicates into one survivor) — all human-approved through the same rail.
- **Cadence**: a weekly scheduler (`apps/bot/src/scheduler/skill-review.ts`, started in `index.ts`; first run ~15 min after boot — deliberately staggered past the routine review's ~5 min so when both passes have something to say, the routine proposal deterministically gets the chat's one pending-proposal slot first). Both schedulers are thin wrappers over the shared `startPeriodicReview` factory (`apps/bot/src/scheduler/review-scheduler.ts`); each run is its own root trace. The recurring interval is registered when the startup timer fires — not at boot — so every weekly tick inherits the same per-pass offset. Correctness never rides on the offset: overlapping passes are serialized FIFO inside the shared per-chat runner (`runReviewForEachChat` queues each pass on a module-level promise chain — sufficient in the bot's single process), so two passes can never both read the read-then-insert one-pending guard's "no pending" state and stack confirmations. The stagger only decides which pass goes first.
- **The recency signal**: skills have no run log, so the facts-only pre-filter `skillNeedsReview` (`packages/db/src/models/skill.ts`) keys on review recency instead of failure rates: a skill is due when it has **never been reviewed**, or when it is **stale** (no use in `STALE_AFTER_DAYS = 30`; `createdAt` fallback when never used) **and** past the **review cooldown** (`lastReviewedAt` ≥ `REVIEW_COOLDOWN_DAYS = 30` ago). Disabled skills are never due. Any version-bumping write clears `lastReviewedAt` at the model — `updateSkillIfVersion` always, `updateSkill` whenever the patch bumps `version` (dashboard content edits) — because the new version was never reviewed, so a stale verdict's cooldown must not shield edited content from the next cycle (enabled-only toggles bump nothing and keep the stamp). The pre-filter only bounds cost; the LLM owns every judgment ("all LLM or no LLM").
- **Flow** (`apps/bot/src/services/skill-review.ts`): for every chat with enabled skills (`listChatIdsWithSkills`, via the shared per-chat runner `runReviewForEachChat` in `apps/bot/src/services/chat-review-runner.ts` — adapter resolution + per-chat failure isolation, shared with the routine review), due candidates are ordered never-reviewed-first (oldest created first), then stale re-reviews by oldest activity, capped at `MAX_SKILLS_PER_REVIEW = 8` (the deferred tail is picked up next cycle once these are stamped). **One** constrained `generateObject` pass (`ModelTier.Smart`, temp 0.2, 60s timeout, tracked under the `skill-review` usage category) covers the whole chat — unlike the routine review's call-per-routine, because the curator needs the candidates side-by-side to spot overlap. The prompt carries the full catalog as context but full bodies only for the candidates, and the LLM may only name candidates in an action (validated against the candidate map; an unknown name, a refine with no content fields, or a malformed merge is warned and skipped so the pass falls through to the next-ranked action). Returns up to `MAX_ACTIONS = 3` ranked actions; an empty list is the correct answer for a healthy library.
- **Stamping is disposition-aware**: a candidate is `markSkillsReviewed`'d (sets `lastReviewedAt`; `{ timestamps: false }`, so no `updatedAt`/`version` bump — a review is metadata, not an edit) **after** the proposals, but only when its review reached a **terminal** outcome: no action targeted it, its proposal was raised, it was durably anti-nag-declined, or its action was malformed/validation-rejected (those fall through and won't change next cycle). A candidate whose action was **deferred** (cap reached after the first raised proposal), **suppressed by a pending confirmation** (the transient `suppressedByPending` flag from the shared guard), or **thrown** stays unstamped, so it re-enters next cycle instead of waiting out a ~30-day cooldown it never actually used. A crash mid-run re-reviews rather than silently skipping; a failed stamp is best-effort (warn only). An LLM failure stamps nothing — a transient outage must not burn a whole cohort's review slot. The stamp is also **version-conditional**: `markSkillsReviewed` takes `{id, version}` pairs (the version each candidate was read at) and only matches a doc still at that version, so a skill edited mid-pass — whose bump just cleared its stamp — is never re-stamped with a verdict about content the pass didn't see.
- **Proposal cores** (`apps/bot/src/ai/tools/skill-refinements.ts`): `proposeSkillRefinement` (skips disabled / empty-body / echo-back-unchanged patches; prunes no-op fields so the signature and the approved args carry only real changes), `proposeSkillArchive`, and `proposeSkillMerge` (survivor must be enabled; absorbees non-empty, distinct from the survivor **and from each other**, all enabled; merged body required; echoed-back unchanged metadata is pruned the same way — the review pass also dedupes a repeated `absorbName` before resolving, since the LLM's intent there is unambiguous). Every bubble shows the full values being approved: the body before/after plus a `field: current → proposed` line for each metadata change — a metadata-only refinement or a merge that also retags the survivor is never approved sight-unseen. All run the shared guard (`raiseGuardedProposal` in `apps/bot/src/ai/tools/proposal-guard.ts`): durable anti-nag via the skill-side decline store (`isSkillRecentlyDeclined`, terminal — sets `declined`) + the one-pending-per-chat check over **all** confirmations (transient — sets `suppressedByPending`, which the review treats as still-pending work). Signatures are **version-scoped** — `skill-refine:{id}#{version}#{hash}`, `skill-archive:{id}#{version}`, `skill-merge:{survivor}#{v}<{sorted absorbed id#v}#{hash}` — so a landed edit (version bump) invalidates old declines while an identical re-proposal of the same fix stays suppressed.
- **Dispatch-only writes** (`apps/bot/src/services/gated-actions.ts`): `updateSkill`, `disableSkill`, and `mergeSkills` are absent from `GATED_TOOL_NAMES` and reachable only through the rail. All three are atomic compare-and-set on version **and `enabled: true`** (`updateSkillIfVersion`), so a skill edited in the ≤2h the bubble sat is rejected (`version_conflict`) rather than clobbered, and one **archived from the dashboard** — which flips `enabled` with **no** version bump — can't be silently rewritten at its stale version. The dispatcher disambiguates a null CAS by re-reading the skill: gone → `not_found`, version moved → `version_conflict`, disabled at the matching version → `state_conflict` (for `updateSkill` and a merge survivor — the merge aborts with nothing changed) — except `disableSkill`, where already-disabled-at-version is a **success no-op** (`alreadyArchived: true`; the goal state already holds). The re-validated args carry **content fields only** (no `enabled`/`name`/`source` — a curation proposal can never rename, re-enable, or change provenance). `mergeSkills` rejects duplicate absorbees at the args schema (`invalid_args` — a doubled absorbee would CAS once, then guarantee a `partial_merge` on its second copy) and **preflights every absorbee before writing anything** — each must still be at its `baseVersion` (enabled, or already archived there — the goal state holds and that version's content is what was folded in); any mismatch cancels the whole merge with nothing changed, because the survivor write is the point of no return. Only then is the survivor's merged content applied (its CAS failing still aborts with nothing changed), and each absorbee disabled by its own CAS; a conflict surviving the preflight (an edit landing in the ms between preflight and archive — unclosable without transactions on standalone Mongo) surfaces as `partial_merge` (failure) so a half-applied merge is visible rather than silent. Like routine curation, **no `accepted` decision is recorded** — the version-scoped signature can't match after the bump, and an archived skill re-enabled from the dashboard must be reviewable again. Deny/cancel records a declined skill proposal (the `SKILL_PROPOSAL_TOOLS` set routes the decline to the skill-side store).

**Architecture**: Service in `apps/bot/src/services/skill-review.ts` (`reviewChatSkills`, `runSkillSelfReview`); scheduler in `apps/bot/src/scheduler/skill-review.ts` over the shared `review-scheduler.ts` factory; proposal cores + signatures in `apps/bot/src/ai/tools/skill-refinements.ts`; shared guard in `apps/bot/src/ai/tools/proposal-guard.ts`; per-chat runner in `apps/bot/src/services/chat-review-runner.ts`; dispatch cases in `apps/bot/src/services/gated-actions.ts`; review helpers (`skillNeedsReview`, `markSkillsReviewed`, `updateSkillIfVersion`, `listChatIdsWithSkills`) in `packages/db/src/models/skill.ts`. Reuses the `SkillProposalDecision` decline store and the confirmation rail. See [skills.md](skills.md#automated-curation-weekly).

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

## MCP tools (external — conditional on `MCP_SERVERS`)

Kokoro can act as an **MCP (Model Context Protocol) client**: at startup it connects to the servers listed in `MCP_SERVERS` and mounts their tools into the conversational palette alongside the hand-written tools above. This is the extensibility seam — adding a third-party capability (a filesystem server, a GitHub server, another Kagami service's `/mcp`, …) becomes a config line instead of a new tool module.

- **Manager**: `apps/bot/src/services/mcp.ts` (`initMcp`, `getMcpTools`, `getMcpSummary`, `shutdownMcp`). `initMcp()` runs once in `apps/bot/src/index.ts` after `loadContext()` and before the schedulers start; `shutdownMcp()` runs alongside `shutdownBrowser()` on signal.
- **Config**: `MCP_SERVERS` is a JSON array validated by `mcpServerSchema` (exported from `@kokoro/shared`). Each entry is one of:
  - `{ name, transport: "http" | "sse", url, headers? }` — remote HTTP/SSE server (redirects rejected to avoid SSRF).
  - `{ name, transport: "stdio", command, args?, env?, cwd? }` — local subprocess (via `@ai-sdk/mcp/mcp-stdio`).
  - `name` must be unique (checked in `validateConfig`) and match `[a-zA-Z0-9_-]`.
- **Namespacing**: each tool is keyed `mcp_<server>_<tool>` (capped at 64 chars), so MCP tools can never shadow a built-in (`searchMemory`, `sendPhoto`, …) and same-named tools across servers stay distinct. The merge in `allTools` is guarded so a built-in always wins on any collision.
- **Fail-open**: a server that won't connect (or whose tool listing fails / times out at 15 s) is logged at `warn` and skipped — the bot starts with the remaining servers' tools, matching the Kioku/Kizuna client posture. A half-open client is closed so a failed stdio spawn doesn't leak a child process.
- **Read-only invariant preserved**: MCP tools are merged **only in `allTools`** (main chat, routines, proactive). They are deliberately absent from `watcherTools` / `routineToolsUnderWatcher`, because an external tool's read/write purity can't be classified — watcher ticks must stay observe-only.
- **Discovery in the prompt**: `assembleMcpContext()` (in `context-assembler.ts`) lists connected servers, their mounted tool keys, and any server-provided `instructions` under an `## External Tools (MCP)` section, mirroring how available routine names are surfaced. Per-tool semantics travel on each tool's own MCP-provided description.
- **Dependency**: `@ai-sdk/mcp` (`createMCPClient`). MCP tool calls execute without the confirmation gate — the trust boundary is "operator chose to configure this server" (single-user localhost). Revisit before any non-localhost exposure.

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
