# AI Layer

The AI layer handles LLM integration, prompt assembly, tool orchestration, image generation, and response delivery. All code lives under `apps/bot/src/ai/` and `apps/bot/src/context/`.

## Provider Configuration

Defined in `apps/bot/src/ai/provider.ts`. Uses the Vercel AI SDK (`ai` package).

| Env Variable                 | Description                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LLM_PROVIDER`               | `"anthropic"` (default), `"openai"`, or `"xai"`                                                                                                                    |
| `LLM_MODEL`                  | Model identifier (default: `"claude-sonnet-4-6"`; recommended xAI model: `grok-4-1-fast-non-reasoning`)                                                            |
| `ANTHROPIC_API_KEY`          | Required if provider is `anthropic` (validated at startup)                                                                                                         |
| `OPENAI_API_KEY`             | Required if provider is `openai` (validated at startup)                                                                                                            |
| `XAI_API_KEY`                | Required if provider is `xai` (validated at startup)                                                                                                               |
| `IMAGE_GENERATION_MODEL`     | Image model in `provider/model` format (e.g., `xai/grok-imagine-image`, `google/gemini-2.5-flash-image`, `openai/gpt-image-1`). Enables `sendPhoto` tool when set. |
| `GOOGLE_API_KEY`             | Required for embedding generation (Google Gemini `gemini-embedding-001`)                                                                                           |
| `EMBEDDING_MODEL`            | Embedding model name (default: `"gemini-embedding-001"`)                                                                                                           |
| `LOCATION_ENABLED`           | Feature gate for location awareness (default: `false`)                                                                                                             |
| `GOOGLE_MAPS_API_KEY`        | Google Maps Geocoding API key (required when `LOCATION_ENABLED=true`)                                                                                              |
| `LOCATION_CONTEXT_MAX_AGE_H` | Max age in hours for location data to appear in LLM context (default: `12`)                                                                                        |

`getModel(tier?)` returns a `LanguageModel` instance from the appropriate SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`, or `@ai-sdk/xai`).

### Model Tiers

The `ModelTier` enum lets call sites declare intent rather than hardcoding model IDs. The provider maps each tier to the right model.

| Tier      | Purpose                              | Anthropic           | OpenAI             | xAI                           |
| --------- | ------------------------------------ | ------------------- | ------------------ | ----------------------------- |
| `Default` | Conversations, curation              | `config.LLM_MODEL`  | `config.LLM_MODEL` | `config.LLM_MODEL`            |
| `Fast`    | Cheap classification (ref selection) | `claude-haiku-4-5`  | `gpt-4o-mini`      | `grok-4-1-fast-non-reasoning` |
| `Smart`   | Maximum reasoning (reserved)         | `claude-sonnet-4-6` | `gpt-4o`           | `grok-4`                      |

## Context Assembly Pipeline

Implemented in `apps/bot/src/ai/context-assembler.ts`. The system prompt is built from MongoDB and the personality card at generation time.

```
assembleSystemPrompt(chatId, sessionId?)
    │
    ├─ 1. Personality card       ← vault/personality/card.md
    ├─ 2. User knowledge         ← engine.getTopFacts(30) — MongoDB
    ├─ 3. Milestones             ← engine.getRecentMilestones(5) — MongoDB
    ├─ 4. Daily episodes         ← engine.getRecentDailyEpisodes(3) — MongoDB
    ├─ 5. Weekly episodes        ← engine.getRecentWeeklyEpisodes(2) — MongoDB
    ├─ 6. Working memory         ← engine.getWorkingMemories(sessionId) — MongoDB (if sessionId)
    ├─ 7. Follow-ups             ← engine.getActiveFollowUps() — 30-day limit, deduped
    ├─ 8. Emotional note         ← injected when mood trend is rising or falling (not stable)
    ├─ 9. Location context       ← last known location if within LOCATION_CONTEXT_MAX_AGE_H (conditional on LOCATION_ENABLED)
    ├─ 10. Datetime context      ← current time + time-of-day label
    ├─ 11. Tool behavior guidelines← compact behavioral rules in prompts.ts (tool schemas are self-describing)
    ├─ 12. Maid service instructions← conditional on Google OAuth config (prompts.ts, condensed)
    ├─ 13. Browser instructions   ← conditional on BROWSER_ENABLED (prompts.ts, condensed)
    ├─ 14. Response format        ← message style rules in prompts.ts
    └─ 15. Active reminders       ← pending + recently fired (proactive only)

    All parts joined with "---" separator
```

All dynamic memory content (facts, milestones, episodes, working memory, follow-ups) is loaded from MongoDB. The vault is only used for the personality card.

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

Defined in `apps/bot/src/ai/tools/`. All tools are passed to `generateText()` and the LLM can invoke them across up to 5 steps.

### Tool Context

```typescript
interface ToolContext {
  chatId: string;
  adapter: PlatformAdapter;
  sessionId: string;
}

allTools(ctx) → { rememberFact, noteToSelf, readMemory, searchMemory, listMemories, curateMemory, sendPhoto?, checkEmail?, sendEmail?, manageCalendar?, manageReminders?, browse?, manageWorkflows }
```

### rememberFact

- **Purpose**: Save important facts or milestones directly to MongoDB
- **Parameters**: `{ content: string, type: "fact" | "milestone", importance: 1-10 }`
- **Returns**: `{ success: true, memoryId, type, content, importance }` or `{ success: false, reason, existing }` if duplicate
- **Behavior**: Checks for duplicate facts (cosine similarity ≥ 0.85) before saving. If a similar fact exists, returns the existing content instead of creating a duplicate. Stores directly in Memory collection with embedding. No vault involvement.

### noteToSelf

- **Purpose**: Make session-scoped temporary notes
- **Parameters**: `{ note: string }`
- **Returns**: `{ success: true, memoryId, note, expiresIn: "24 hours" }`
- **Behavior**: Stores as working memory with TTL. Auto-expires after 24 hours. Injected into system prompt as "Currently Tracking" section.

### readMemory

- **Purpose**: Read the personality card from vault, or a specific memory by ID from MongoDB
- **Parameters**: `{ path?: string, memoryId?: string }`
- **Returns**: `{ found: boolean, content?: string }` or `{ found: boolean, id, type, content, createdAt, importance }`
- **Use case**: Recall stored personality definition, or inspect a specific memory found via search/list

### searchMemory

- **Purpose**: Semantic search across all memories
- **Parameters**: `{ query: string, type?: "fact" | "episode" | "milestone" }`
- **Returns**: `{ found: boolean, results: [{ id, source, content, score, type }] }`
- **Behavior**: Uses Memory Engine's `recall()` with tiered search (90d → 365d), composite scoring, and 200-candidate cap. Results limited to 10 by default with a minimum match score of 0.3. Optional type filter. Excludes archived memories.

### listMemories

- **Purpose**: Discover available memories by type
- **Parameters**: `{ type?: "fact" | "episode" | "milestone", limit?: number }`
- **Returns**: `{ found: boolean, count, memories: [{ id, type, date, preview, importance }] }`
- **Behavior**: Queries the Memory collection, excludes archived memories, returns recent memories sorted by date

### curateMemory

- **Purpose**: Trigger the curation pipeline (summarize overflow, extract facts)
- **Parameters**: none
- **Returns**: `{ success: true, message: "Curation started in background" }`
- **Behavior**: Fire-and-forget — starts curation without blocking the response

### sendPhoto

- **Purpose**: Generate and send an AI photo/selfie
- **Parameters**: `{ description: string, caption?: string, aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" }`
- **Returns**: `{ sent: true, caption } | { sent: false, reason }`
- **Behavior**: Builds prompt with appearance prefix, calls image generation, sends via adapter

### checkEmail (conditional — requires Google OAuth)

- **Purpose**: Check Goshujin-sama's email
- **Parameters**: `{ maxResults?: number, emailId?: string }`
- **Returns**: `{ success, count?, emails? }` or `{ success, email }` or `{ success: false, reason }`
- **Behavior**: Lists unread emails or retrieves a specific email by ID. Only registered when `GOOGLE_OAUTH_CLIENT_ID` is configured.

### sendEmail (conditional — requires Google OAuth)

- **Purpose**: Send an email or reply to a thread on behalf of Goshujin-sama
- **Parameters**: `{ to: string, subject: string, body: string, threadId?: string, inReplyTo?: string }`
- **Returns**: `{ success: true, id, threadId }` or `{ success: false, reason }`
- **Behavior**: Composes a plain-text RFC 2822 message and sends via Gmail API. When `threadId` and `inReplyTo` are provided (from `checkEmail` results), sends as a threaded reply with proper `In-Reply-To` and `References` headers. Requires `gmail.send` OAuth scope. Only registered when `GOOGLE_OAUTH_CLIENT_ID` is configured.

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

### browse (conditional — requires BROWSER_ENABLED=true)

- **Purpose**: Browse the web — search, visit pages, extract data, interact with elements, take screenshots, or complete multi-step autonomous tasks
- **Parameters**: `{ action: "search"|"visit"|"extract"|"act"|"screenshot"|"agent", query?, url?, instruction?, goal? }`
- **Returns**: Varies by action. Always includes `{ success: boolean }`.
- **Behavior**: Uses Stagehand (LLM-driven browser automation on accessibility tree) with a singleton Chromium instance. Lazy-initialized on first call, auto-shuts down after 5 minutes idle. Persistent user profile preserves cookies/logins across restarts.

| Action       | Required param | What it does                                                 | Stagehand method                            |
| ------------ | -------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `search`     | `query`        | DuckDuckGo search → structured results (title, URL, snippet) | `page.goto()` + `extract()` with Zod schema |
| `visit`      | `url`          | Navigate + extract readable text (truncated 4000 chars)      | `page.goto()` + `extract()` raw pageText    |
| `extract`    | `instruction`  | Structured extraction from current page                      | `stagehand.extract(instruction)`            |
| `act`        | `instruction`  | Interact with page (click, type, scroll)                     | `stagehand.act(instruction)`                |
| `screenshot` | —              | Capture page → send as photo                                 | `page.screenshot()`                         |
| `agent`      | `goal`         | Autonomous multi-step task (up to 25 steps)                  | `stagehand.agent().execute()`               |
| `login`      | `url`          | Opens login page for manual credential entry                 | `page.goto()` (no browser release)          |

**Architecture**: Two independent LLM streams — Mashiro's main loop (Sonnet) decides _what_ to browse, Stagehand's internal calls (Haiku/Fast tier) decide _how_ to navigate. Configured via `BROWSER_ENABLED`, `BROWSER_DATA_DIR`, `BROWSER_HEADLESS` env vars. Browser service in `apps/bot/src/services/browser.ts`, tool in `apps/bot/src/ai/tools/browse.ts`.

### manageWorkflows

- **Purpose**: Manage automated workflows that run on cron schedules
- **Parameters**: `{ action: "create"|"list"|"update"|"delete"|"enable"|"disable"|"trigger", workflowId?, name?, prompt?, cronSchedule?, reportMode? }`
- **Returns**: `{ success, workflowId? }` or `{ success, workflows? }` or `{ success: false, reason }`
- **Behavior**: Creates, lists, updates, deletes, enables/disables, or triggers workflows. Workflows are natural language task descriptions that execute autonomously on a cron schedule using all available tools. Each workflow has a `reportMode`: `"always"` sends a summary after every run, `"alert"` only messages when something noteworthy or an error occurs. The `trigger` action runs a workflow immediately (fire-and-forget). Cron expressions are validated before saving.

**Workflow Execution**: Workflows run via `generateText` with a clean context (personality + datetime + tool instructions, no conversation history), `stopWhen: stepCountIs(20)`, and `temperature: 0.4`. A separate execution log (`WorkflowLog`) tracks each run's status, summary, and timing. The scheduler polls every 60s, skips workflows that are already running, and resets stale locks on startup.

**Architecture**: Executor service in `apps/bot/src/services/workflow-executor.ts`, scheduler in `apps/bot/src/scheduler/workflows.ts`, cron helper in `apps/bot/src/services/cron.ts`, tool in `apps/bot/src/ai/tools/manage-workflows.ts`. DB models (`Workflow`, `WorkflowLog`) in `packages/db/src/models/workflow.ts`.

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
    ├─ 1. Build prompt with APPEARANCE_PREFIX
    │      (realistic phone photo, match face/hair/features from references)
    │
    ├─ 2. Select references (all via LLM, in parallel):
    │      ├─ Face reference (LLM picks best expression/angle)
    │      ├─ Body reference (LLM picks best pose/framing)
    │      └─ Outfit (LLM picks best match from available options)
    │
    ├─ 3. LLM selects setting/location if relevant
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

| Parameter     | Value                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| `model`       | From `getModel()` (provider-dependent)                                                     |
| `system`      | Assembled system prompt (with sessionId)                                                   |
| `messages`    | Last 40 messages from active session (reconstructed)                                       |
| `tools`       | `allTools(ctx)` — includes sessionId for noteToSelf                                        |
| `stopWhen`    | `stepCountIs(5)`                                                                           |
| `temperature` | 0.7                                                                                        |
| `abortSignal` | `AbortSignal.timeout(120_000)` — 2 minute timeout (30s for Fast tier classification calls) |

## Token Usage Observability

All LLM call sites track token usage via `apps/bot/src/ai/token-tracker.ts`. Each call logs prompt/completion tokens and estimated cost via Pino, then persists to the `TokenUsage` MongoDB collection (fire-and-forget).

### Categories

| Category           | Call Sites                                                           |
| ------------------ | -------------------------------------------------------------------- |
| `conversation`     | Main `generateText` in `generate.ts`                                 |
| `proactive`        | Proactive message generation in `proactive.ts`                       |
| `workflow`         | Workflow execution in `workflow-executor.ts`                         |
| `curation`         | All curator calls (summary, facts, follow-ups, weekly/monthly merge) |
| `image-selection`  | Reference image selection (outfit, face, body, setting)              |
| `image-generation` | Image generation via AI SDK (fixed cost per call, model-dependent)   |

### Pricing

Cost estimation uses a per-model lookup table (`MODEL_PRICING` in `token-tracker.ts`). Image generation uses a fixed cost per call. The `getModelName(tier)` helper in `provider.ts` resolves the string model ID without creating a provider instance.

### Dashboard

The `/usage` page displays cost breakdowns by category, daily trends, and summary stats (today/week/month). Queries in `apps/dashboard/src/lib/queries/usage.ts`. The `TokenUsage` model and aggregation helpers (`getUsageSummary`, `getDailyUsage`, `getTotalCost`) are exported from `@mashiro/db`.
