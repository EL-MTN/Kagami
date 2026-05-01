# Routines

Routines are reusable, parameterized capabilities that the LLM can create, manage, and invoke. A routine is a natural language prompt that executes as an independent `generateText()` call with full tool access. Routines can run on-demand, on a cron schedule, or be composed by other routines up to three levels deep.

## Architecture: Tools, Routines, and Conversation

The system has three distinct layers, each with a different execution model:

```
┌─────────────────────────────────────────────────────────┐
│  Conversation LLM                                       │
│  Nondeterministic · Full personality · Memory context    │
│  Presents results in character                          │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Routines (on-demand, via useRoutine)                 │  │
│  │  Nondeterministic · Lean executor prompt          │  │
│  │  Multi-step reasoning · Returns factual results   │  │
│  │                                                   │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  Tools (always registered)                  │  │  │
│  │  │  Deterministic · Single-operation            │  │  │
│  │  │  Direct API/DB calls · Structured returns   │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Tools** are deterministic, single-operation functions. `checkEmail()` makes one Gmail API call. `browse({ action: "search", query })` runs one search. Their schemas are always loaded in the tool set for every `generateText()` call — conversation, proactive, or routine. They are the atomic building blocks.

**Routines** are nondeterministic, multi-step LLM calls that orchestrate tools. A "morning-brief" routine might call `checkEmail`, `manageCalendar`, and `browse` internally, reason about the combined results, and return a synthesized summary. Routines run with a lean executor prompt (no personality, no conversational instructions) and return factual results. They are listed by name and description in the system prompt for awareness, but only execute when the LLM calls `useRoutine`. They are the compositional layer.

**The conversation LLM** is the personality layer. It has the full character context (personality card, memory, facts, episodes, emotional tracking) and decides when to invoke routines, how to present their results in character, and how to respond to the user. It never leaks into routine execution — routines don't know or care about personality.

This separation means:

- Tools are cheap (one API call, no LLM reasoning)
- Routines are moderate (lean LLM call, multi-step tool orchestration)
- The conversation is rich (full personality context, but isolated from routine internals)
- Routines never duplicate tool functionality — they compose tools into higher-level capabilities

### Example: Composed routine flow

```
Conversation LLM (personality + memory + full context)
  │
  ├─ sees "Available Routines: morning-brief, translate, ..."
  │
  ├─ calls searchRoutines({ query: "morning" })
  │    └─ returns full details: name, description, parameters, cron
  │
  └─ calls useRoutine("morning-brief")
       │
       Routine LLM (lean executor, no personality, has all tools)
         ├─ calls checkEmail()            ← deterministic tool
         ├─ calls manageCalendar("list")  ← deterministic tool
         ├─ calls browse("search", ...)   ← deterministic tool
         ├─ reasons about combined results ← nondeterministic
         └─ returns: "3 unread emails, 2 meetings today, rain forecast"
       │
  ├─ receives factual summary
  └─ responds in character: "you've got 3 emails and 2 meetings~
      also it's gonna rain so bring an umbrella okay"
```

## Schema

Two MongoDB collections back the routine system: `Routine` (definitions) and `RoutineLog` (execution history). Models are defined in `packages/db/src/models/routine.ts`.

### Routine

| Field                  | Type                  | Description                                                                                  |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `chatId`               | `string`              | Telegram chat this routine belongs to                                                        |
| `name`                 | `string`              | Unique name within the chat (used as identifier for `useRoutine`)                            |
| `description`          | `string`              | What the routine does — shown in the system prompt routine listing                           |
| `prompt`               | `string`              | Execution instructions — sent as the user message in the LLM call                            |
| `parameters`           | `IRoutineParameter[]` | Typed parameter definitions (see below)                                                      |
| `cronSchedule`         | `string \| null`      | Cron expression for automatic scheduling, or null for on-demand                              |
| `reportMode`           | `"always" \| "alert"` | Whether to message the user after every run or only on noteworthy/failed runs                |
| `nextRunAt`            | `Date \| null`        | Next scheduled execution time (computed from cron)                                           |
| `manualRunRequestedAt` | `Date \| null`        | Set by the dashboard "Run Now" action; cleared atomically when the bot's scheduler claims it |
| `enabled`              | `boolean`             | Whether the routine is active (default: `true`)                                              |
| `version`              | `number`              | Incremented on every update                                                                  |
| `createdAt`            | `Date`                | Mongoose timestamp                                                                           |
| `updatedAt`            | `Date`                | Mongoose timestamp                                                                           |

### Routine Parameters

Each parameter has:

| Field         | Type                                                       | Description                                                                            |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `name`        | `string`                                                   | Parameter name                                                                         |
| `type`        | `"string" \| "number" \| "boolean" \| "array" \| "object"` | Value type (coerced at invocation time — arrays/objects accept JSON strings or values) |
| `description` | `string`                                                   | What this parameter is for                                                             |
| `required`    | `boolean`                                                  | Whether the caller must provide it                                                     |
| `default`     | `unknown`                                                  | Default value (required params on cron routines must have defaults)                    |

### RoutineLog

| Field         | Type                                   | Description                                |
| ------------- | -------------------------------------- | ------------------------------------------ |
| `routineId`   | `ObjectId`                             | Reference to the Routine document          |
| `trigger`     | `"cron" \| "manual" \| "routine"`      | How the execution was initiated            |
| `parentLogId` | `ObjectId?`                            | Parent log when invoked by another routine |
| `parameters`  | `Record<string, unknown>?`             | Resolved parameters for this execution     |
| `status`      | `"running" \| "completed" \| "failed"` | Current execution status                   |
| `summary`     | `string?`                              | LLM response text or error reason          |
| `startedAt`   | `Date`                                 | When execution began                       |
| `completedAt` | `Date?`                                | When execution finished                    |

### Indexes

- `{ chatId: 1 }` — list routines for a chat
- `{ chatId: 1, name: 1 }` — unique compound index (enforces name uniqueness per chat)
- `{ enabled: 1, nextRunAt: 1 }` — efficient query for due cron routines
- `{ routineId: 1, startedAt: -1 }` — log lookup by routine, most recent first

## Tools

Three tools expose the routine system to the LLM. All are always registered (not conditional on config). Defined in `apps/bot/src/ai/tools/manage-routines.ts`, `apps/bot/src/ai/tools/search-routines.ts`, and `apps/bot/src/ai/tools/use-routine.ts`.

### manageRoutines

CRUD operations for routine definitions. Actions: `create`, `list`, `update`, `delete`, `enable`, `disable`.

**Parameters:**

| Parameter      | Required for                 | Description                                                      |
| -------------- | ---------------------------- | ---------------------------------------------------------------- |
| `action`       | all                          | One of `create`, `list`, `update`, `delete`, `enable`, `disable` |
| `routineId`    | update/delete/enable/disable | Routine document ID                                              |
| `name`         | create                       | Unique routine name within the chat                              |
| `description`  | create                       | What the routine does                                            |
| `prompt`       | create                       | Execution instructions (natural language task description)       |
| `parameters`   | optional                     | Typed parameter definitions array                                |
| `cronSchedule` | optional                     | Cron expression (omit for on-demand only)                        |
| `reportMode`   | create                       | `"always"` or `"alert"`                                          |

**Validation rules:**

- Cron expressions are validated before saving (`isValidCron()`)
- Cron-scheduled routines require all required parameters to have default values (the scheduler cannot prompt for input)
- Duplicate names within a chat are rejected (MongoDB unique index, caught as error code 11000)
- Updates increment the `version` field
- Deleting a routine also deletes all its logs

### searchRoutines

Searches enabled routines by keyword. Defined in `apps/bot/src/ai/tools/search-routines.ts`.

**Parameters:**

| Parameter | Required | Description                                              |
| --------- | -------- | -------------------------------------------------------- |
| `query`   | no       | Keywords to match against routine names and descriptions |

**Returns:** `{ success, count, routines: [{ name, description, parameters, cronSchedule, reportMode }] }`

Call with no query to list all enabled routines. Keywords are matched as substrings against the concatenation of routine name and description — all terms must match.

### useRoutine

Invokes a routine by name. The routine executes as a sub-`generateText()` call and returns its result synchronously to the calling LLM.

**Parameters:**

| Parameter     | Required | Description                         |
| ------------- | -------- | ----------------------------------- |
| `routineName` | yes      | Name of the routine to invoke       |
| `parameters`  | no       | Key-value map of parameters to pass |

**Behavior:**

1. Checks recursion depth against `MAX_ROUTINE_DEPTH` (3)
2. Looks up the routine by `{chatId, name}` — rejects if not found or disabled
3. Validates and coerces parameters against the routine's parameter schema (type coercion for string/number/boolean, JSON parsing for array/object, default filling, extra params passed through)
4. Calls `executeRoutine()` with `trigger: "routine"` and `depth + 1`
5. Returns `{ success, routineName, result }` synchronously

**Depth gating:** The `useRoutine` tool is only registered when `depth < MAX_ROUTINE_DEPTH`. At depth 3, the tool is omitted from the tool set entirely, so the LLM cannot attempt further nesting.

## Execution Model

Routine execution is handled by `apps/bot/src/services/routine-executor.ts`. The core function `executeRoutine()` runs the same flow regardless of trigger source.

### Execution Flow

```
executeRoutine(routine, adapter, options)
    |
    +-- 1. Concurrency guard (cron/manual only)
    |      isRoutineRunning(routineId) — checks for "running" logs
    |      newer than 15 minutes (stale threshold)
    |
    +-- 2. Create RoutineLog with status "running"
    |
    +-- 3. Assemble system prompt (lean — no personality or conversational instructions)
    |      executor identity ("You are a task executor...")
    |      + datetime context
    |      + report mode instruction (cron triggers only)
    |      + routine name header
    |      + parameter injection (formatted as markdown list)
    |
    +-- 4. generateText()
    |      model: getModel() (default tier)
    |      system: assembled routine prompt
    |      messages: [{ role: "user", content: routine.prompt }]
    |      tools: allTools(ctx) with routineDepth set
    |      stopWhen: stepCountIs(maxSteps)
    |      temperature: varies by context
    |      abortSignal: 3 minute timeout
    |
    +-- 5. Track token usage under "routine" category
    |
    +-- 6. Complete log with response text
    |
    +-- 7. Advance cron schedule (if advanceSchedule=true)
    |      Computed from previous slot, not current time (prevents drift)
    |
    +-- 8. Deliver report (cron/manual only, not composed calls)
    |      "always" mode: send response via sendSegmented()
    |      "alert" mode: send only if response is not "[no report]"
    |
    +-- On error: fail log, advance cron anyway, notify user (cron/manual only)
```

### Step Limits and Temperature

Execution parameters vary by trigger context to balance capability against cost:

| Trigger                         | Max Steps | Temperature | Rationale                            |
| ------------------------------- | --------- | ----------- | ------------------------------------ |
| Cron (scheduled)                | 20        | 0.4         | Autonomous tasks may need many tools |
| Manual (depth 0)                | 10        | 0.5         | User-triggered, moderate complexity  |
| Composed (depth > 0, `routine`) | 5         | 0.4         | Sub-tasks should be focused          |

### Prompt Assembly

Routines use a lean system prompt that strips all personality and conversational context. The rationale: routines are like tool calls — they execute a task and return results. The calling LLM (which has the full personality context) is responsible for presenting the result in character.

The routine system prompt contains only:

1. **Executor identity**: `"You are a task executor. Complete the routine... Be concise and factual — return results, not commentary. Do not adopt a persona or use conversational tone."`
2. **Datetime context**: current date/time and time-of-day label
3. **Report mode instruction** (cron triggers only): tells the LLM whether to always report or only on noteworthy events
4. **Routine name + parameters**: formatted as markdown

This is deliberately minimal. No personality card, no tool behavioral guidelines, no maid/browser/response format instructions. This keeps token cost low per invocation while preserving full tool access and reasoning capability. The `prompt` field is injected as the sole user message.

### Tool Access

Routines receive the full tool set via `allTools(ctx)` with the `routineDepth` field set on the `ToolContext`. This means routines can use memory tools, send photos, browse the web, manage calendar events, and invoke other routines. The only restriction is depth gating on `useRoutine` itself.

## Routine Discovery

Routines use a search-based discovery pattern to keep system prompt token usage low as the routine inventory grows.

### System Prompt (compact listing)

The context assembler (`apps/bot/src/ai/context-assembler.ts`) injects only routine **names** into the system prompt — no parameters, descriptions, or cron schedules:

```
## Available Routines
check-emails, weather-report, morning-brief
Use searchRoutines to look up details or discover routines by keyword.
```

This gives the LLM awareness of what exists without paying the token cost of full schema definitions on every turn.

### searchRoutines Tool (on-demand details)

When the LLM needs to invoke a routine or explore available capabilities, it calls `searchRoutines`:

- `searchRoutines({})` — returns all enabled routines with full details
- `searchRoutines({ query: "email" })` — keyword search against routine names and descriptions

Returns name, description, parameters (with types and required flags), cron schedule, and report mode for each match. This is the primary way the LLM gets parameter information before calling `useRoutine`.

## Scheduler

The routine scheduler (`apps/bot/src/scheduler/routines.ts`) handles automatic execution of cron-scheduled routines.

### Polling

- **Cron tick**: every 60 seconds via `setInterval`. Queries `getDueRoutines()` (enabled routines where `cronSchedule` is not null and `nextRunAt <= now`) and executes each with `trigger: "cron"`, `advanceSchedule: true`.
- **Manual-run tick**: every 3 seconds. Calls `claimPendingManualRun()` — an atomic `findOneAndUpdate` that clears `manualRunRequestedAt` and returns the claimed routine — and executes it with `trigger: "manual"`, `advanceSchedule: false`, `silent: true`. The dashboard sets `manualRunRequestedAt` via `POST /api/routines/[id]/run`; the bot picks it up within ~3 s and writes the result to a `RoutineLog` that the dashboard polls. Silent mode suppresses the Telegram delivery so testing from the dashboard doesn't spam the chat.
- Both intervals are `unref()`ed so they don't keep the process alive.

### Cron Parameter Defaults

When the scheduler fires a cron routine, it builds a parameter map from each parameter's `default` value. This is why cron-scheduled routines must have defaults for all required parameters — there is no user to supply them at execution time.

### Startup Recovery

On boot, the scheduler:

1. Resets stale running logs — any `RoutineLog` with `status: "running"` and `startedAt` older than 15 minutes is marked as `failed` with summary "Process crashed during execution"
2. Immediately runs any routines that are past due (catches up after downtime)

### Concurrent Execution Guard

`isRoutineRunning(routineId)` checks for any `RoutineLog` with `status: "running"` and `startedAt` within the last 15 minutes. If found, the cron/manual trigger skips execution. Composed calls (`trigger: "routine"`) bypass this guard since they are controlled by the parent's step limit.

The 15-minute stale threshold ensures that crashed executions (where the log was never completed) do not permanently block the routine.

### Cron Advancement

After execution (success or failure), the next run time is computed from the **previous** `nextRunAt` slot, not from the current time. This prevents schedule drift — if a routine was due at 09:00 but executed at 09:01, the next run is computed relative to 09:00.

### Cleanup

Old routine logs (completed or failed, older than 90 days) are cleaned up by the daily cleanup routine in the proactive scheduler.

## Composability and Depth Limiting

Routines can invoke other routines via the `useRoutine` tool, enabling composition:

```
Routine A (depth 0) -- useRoutine --> Routine B (depth 1) -- useRoutine --> Routine C (depth 2)
```

### Depth Tracking

- `MAX_ROUTINE_DEPTH = 3` (defined in `routine-executor.ts`)
- Each `useRoutine` call increments the depth by 1
- The `useRoutine` tool is only registered in the tool set when `depth < MAX_ROUTINE_DEPTH`
- At depth 3, the `useRoutine` tool is simply absent — the LLM cannot see it or attempt to call it

### Execution Logs for Composed Calls

Composed routine executions use `trigger: "routine"` and set `parentLogId` to the calling routine's log ID. This creates a traceable tree of execution:

```
RoutineLog (Routine A, trigger: "cron")
  +-- RoutineLog (Routine B, trigger: "routine", parentLogId: ^)
        +-- RoutineLog (Routine C, trigger: "routine", parentLogId: ^)
```

### Behavioral Differences for Composed Calls

- **No concurrency guard** — composed calls skip `isRoutineRunning()` since the parent already holds execution context
- **No user notification** — composed calls return their result to the calling LLM instead of sending messages to the chat
- **Lower step limit** — 5 steps instead of 10/20, keeping sub-tasks focused
- **Synchronous return** — the calling LLM receives the routine's text output as a tool result

## File Map

| File                                        | Purpose                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/models/routine.ts`         | Mongoose models (`Routine`, `RoutineLog`), CRUD helpers, log helpers                                                                     |
| `apps/bot/src/ai/tools/manage-routines.ts`  | `manageRoutines` tool (create/list/update/delete/enable/disable)                                                                         |
| `apps/bot/src/ai/tools/search-routines.ts`  | `searchRoutines` tool (keyword discovery of available routines)                                                                          |
| `apps/bot/src/ai/tools/use-routine.ts`      | `useRoutine` tool (invoke by name with parameters)                                                                                       |
| `apps/bot/src/services/routine-executor.ts` | `executeRoutine()` — prompt assembly, `generateText()`, logging, reporting; `silent` option suppresses Telegram delivery                 |
| `apps/bot/src/scheduler/routines.ts`        | Routine scheduler — cron polling (60 s) + manual-run polling (3 s)                                                                       |
| `packages/shared/src/routine-validation.ts` | Shared cron validation (`isValidCron`, `computeNextRunAt`, `validateCronAndDefaults`) used by both the bot tool and dashboard API routes |
| `apps/bot/src/ai/tools/index.ts`            | Tool registration with depth gating                                                                                                      |
| `apps/bot/src/ai/context-assembler.ts`      | Routine context injection into system prompt                                                                                             |
| `apps/bot/src/ai/prompts.ts`                | `ROUTINE_BEHAVIOR_INSTRUCTIONS` constant                                                                                                 |
