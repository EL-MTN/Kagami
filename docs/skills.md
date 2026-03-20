# Skills

Skills are reusable, parameterized capabilities that the LLM can create, manage, and invoke. A skill is a natural language prompt that executes as an independent `generateText()` call with full tool access. Skills can run on-demand, on a cron schedule, or be composed by other skills up to three levels deep.

## Architecture: Tools, Skills, and Conversation

The system has three distinct layers, each with a different execution model:

```
┌─────────────────────────────────────────────────────────┐
│  Conversation LLM                                       │
│  Nondeterministic · Full personality · Memory context    │
│  Presents results in character                          │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Skills (on-demand, via useSkill)                 │  │
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

**Tools** are deterministic, single-operation functions. `checkEmail()` makes one Gmail API call. `browse({ action: "search", query })` runs one search. Their schemas are always loaded in the tool set for every `generateText()` call — conversation, proactive, or skill. They are the atomic building blocks.

**Skills** are nondeterministic, multi-step LLM calls that orchestrate tools. A "morning-brief" skill might call `checkEmail`, `manageCalendar`, and `browse` internally, reason about the combined results, and return a synthesized summary. Skills run with a lean executor prompt (no personality, no conversational instructions) and return factual results. They are listed by name and description in the system prompt for awareness, but only execute when the LLM calls `useSkill`. They are the compositional layer.

**The conversation LLM** is the personality layer. It has the full character context (personality card, memory, facts, episodes, emotional tracking) and decides when to invoke skills, how to present their results in character, and how to respond to the user. It never leaks into skill execution — skills don't know or care about personality.

This separation means:

- Tools are cheap (one API call, no LLM reasoning)
- Skills are moderate (lean LLM call, multi-step tool orchestration)
- The conversation is rich (full personality context, but isolated from skill internals)
- Skills never duplicate tool functionality — they compose tools into higher-level capabilities

### Example: Composed skill flow

```
Conversation LLM (personality + memory + full context)
  │
  ├─ sees "Available Skills: morning-brief, translate, ..."
  │
  └─ calls useSkill("morning-brief")
       │
       Skill LLM (lean executor, no personality, has all tools)
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

Two MongoDB collections back the skill system: `Skill` (definitions) and `SkillLog` (execution history). Models are defined in `packages/db/src/models/skill.ts`.

### Skill

| Field          | Type                  | Description                                                                   |
| -------------- | --------------------- | ----------------------------------------------------------------------------- |
| `chatId`       | `string`              | Telegram chat this skill belongs to                                           |
| `name`         | `string`              | Unique name within the chat (used as identifier for `useSkill`)               |
| `description`  | `string`              | What the skill does — shown in the system prompt skill listing                |
| `prompt`       | `string`              | Execution instructions — sent as the user message in the LLM call             |
| `parameters`   | `ISkillParameter[]`   | Typed parameter definitions (see below)                                       |
| `cronSchedule` | `string \| null`      | Cron expression for automatic scheduling, or null for on-demand               |
| `reportMode`   | `"always" \| "alert"` | Whether to message the user after every run or only on noteworthy/failed runs |
| `nextRunAt`    | `Date \| null`        | Next scheduled execution time (computed from cron)                            |
| `enabled`      | `boolean`             | Whether the skill is active (default: `true`)                                 |
| `version`      | `number`              | Incremented on every update                                                   |
| `createdAt`    | `Date`                | Mongoose timestamp                                                            |
| `updatedAt`    | `Date`                | Mongoose timestamp                                                            |

### Skill Parameters

Each parameter has:

| Field         | Type                                                       | Description                                                                            |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `name`        | `string`                                                   | Parameter name                                                                         |
| `type`        | `"string" \| "number" \| "boolean" \| "array" \| "object"` | Value type (coerced at invocation time — arrays/objects accept JSON strings or values) |
| `description` | `string`                                                   | What this parameter is for                                                             |
| `required`    | `boolean`                                                  | Whether the caller must provide it                                                     |
| `default`     | `unknown`                                                  | Default value (required params on cron skills must have defaults)                      |

### SkillLog

| Field         | Type                                   | Description                              |
| ------------- | -------------------------------------- | ---------------------------------------- |
| `skillId`     | `ObjectId`                             | Reference to the Skill document          |
| `trigger`     | `"cron" \| "manual" \| "skill"`        | How the execution was initiated          |
| `parentLogId` | `ObjectId?`                            | Parent log when invoked by another skill |
| `parameters`  | `Record<string, unknown>?`             | Resolved parameters for this execution   |
| `status`      | `"running" \| "completed" \| "failed"` | Current execution status                 |
| `summary`     | `string?`                              | LLM response text or error reason        |
| `startedAt`   | `Date`                                 | When execution began                     |
| `completedAt` | `Date?`                                | When execution finished                  |

### Indexes

- `{ chatId: 1 }` — list skills for a chat
- `{ chatId: 1, name: 1 }` — unique compound index (enforces name uniqueness per chat)
- `{ enabled: 1, nextRunAt: 1 }` — efficient query for due cron skills
- `{ skillId: 1, startedAt: -1 }` — log lookup by skill, most recent first

## Tools

Two tools expose the skill system to the LLM. Both are always registered (not conditional on config). Defined in `apps/bot/src/ai/tools/manage-skills.ts` and `apps/bot/src/ai/tools/use-skill.ts`.

### manageSkills

CRUD operations for skill definitions. Actions: `create`, `list`, `update`, `delete`, `enable`, `disable`.

**Parameters:**

| Parameter      | Required for                 | Description                                                      |
| -------------- | ---------------------------- | ---------------------------------------------------------------- |
| `action`       | all                          | One of `create`, `list`, `update`, `delete`, `enable`, `disable` |
| `skillId`      | update/delete/enable/disable | Skill document ID                                                |
| `name`         | create                       | Unique skill name within the chat                                |
| `description`  | create                       | What the skill does                                              |
| `prompt`       | create                       | Execution instructions (natural language task description)       |
| `parameters`   | optional                     | Typed parameter definitions array                                |
| `cronSchedule` | optional                     | Cron expression (omit for on-demand only)                        |
| `reportMode`   | create                       | `"always"` or `"alert"`                                          |

**Validation rules:**

- Cron expressions are validated before saving (`isValidCron()`)
- Cron-scheduled skills require all required parameters to have default values (the scheduler cannot prompt for input)
- Duplicate names within a chat are rejected (MongoDB unique index, caught as error code 11000)
- Updates increment the `version` field
- Deleting a skill also deletes all its logs

### useSkill

Invokes a skill by name. The skill executes as a sub-`generateText()` call and returns its result synchronously to the calling LLM.

**Parameters:**

| Parameter    | Required | Description                         |
| ------------ | -------- | ----------------------------------- |
| `skillName`  | yes      | Name of the skill to invoke         |
| `parameters` | no       | Key-value map of parameters to pass |

**Behavior:**

1. Checks recursion depth against `MAX_SKILL_DEPTH` (3)
2. Looks up the skill by `{chatId, name}` — rejects if not found or disabled
3. Validates and coerces parameters against the skill's parameter schema (type coercion for string/number/boolean, JSON parsing for array/object, default filling, extra params passed through)
4. Calls `executeSkill()` with `trigger: "skill"` and `depth + 1`
5. Returns `{ success, skillName, result }` synchronously

**Depth gating:** The `useSkill` tool is only registered when `depth < MAX_SKILL_DEPTH`. At depth 3, the tool is omitted from the tool set entirely, so the LLM cannot attempt further nesting.

## Execution Model

Skill execution is handled by `apps/bot/src/services/skill-executor.ts`. The core function `executeSkill()` runs the same flow regardless of trigger source.

### Execution Flow

```
executeSkill(skill, adapter, options)
    |
    +-- 1. Concurrency guard (cron/manual only)
    |      isSkillRunning(skillId) — checks for "running" logs
    |      newer than 15 minutes (stale threshold)
    |
    +-- 2. Create SkillLog with status "running"
    |
    +-- 3. Assemble system prompt (lean — no personality or conversational instructions)
    |      executor identity ("You are a task executor...")
    |      + datetime context
    |      + report mode instruction (cron triggers only)
    |      + skill name header
    |      + parameter injection (formatted as markdown list)
    |
    +-- 4. generateText()
    |      model: getModel() (default tier)
    |      system: assembled skill prompt
    |      messages: [{ role: "user", content: skill.prompt }]
    |      tools: allTools(ctx) with skillDepth set
    |      stopWhen: stepCountIs(maxSteps)
    |      temperature: varies by context
    |      abortSignal: 3 minute timeout
    |
    +-- 5. Track token usage under "skill" category
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

| Trigger                       | Max Steps | Temperature | Rationale                            |
| ----------------------------- | --------- | ----------- | ------------------------------------ |
| Cron (scheduled)              | 20        | 0.4         | Autonomous tasks may need many tools |
| Manual (depth 0)              | 10        | 0.5         | User-triggered, moderate complexity  |
| Composed (depth > 0, `skill`) | 5         | 0.4         | Sub-tasks should be focused          |

### Prompt Assembly

Skills use a lean system prompt that strips all personality and conversational context. The rationale: skills are like tool calls — they execute a task and return results. The calling LLM (which has the full personality context) is responsible for presenting the result in character.

The skill system prompt contains only:

1. **Executor identity**: `"You are a task executor. Complete the skill... Be concise and factual — return results, not commentary. Do not adopt a persona or use conversational tone."`
2. **Datetime context**: current date/time and time-of-day label
3. **Report mode instruction** (cron triggers only): tells the LLM whether to always report or only on noteworthy events
4. **Skill name + parameters**: formatted as markdown

This is deliberately minimal. No personality card, no tool behavioral guidelines, no maid/browser/response format instructions. This keeps token cost low per invocation while preserving full tool access and reasoning capability. The `prompt` field is injected as the sole user message.

### Tool Access

Skills receive the full tool set via `allTools(ctx)` with the `skillDepth` field set on the `ToolContext`. This means skills can use memory tools, send photos, browse the web, manage calendar events, and invoke other skills. The only restriction is depth gating on `useSkill` itself.

## Skill Context in System Prompt

The LLM always knows what skills are available without needing to call `manageSkills list`. The context assembler (`apps/bot/src/ai/context-assembler.ts`) injects an "Available Skills" section into the main conversation system prompt. For each enabled skill, it shows the name, parameter signature, description, and cron schedule (if any).

Example format in the system prompt:

```
## Available Skills
- **check-emails** (maxResults: number?): Check inbox and summarize unread emails [cron: 0 9 * * *]
- **weather-report** (city: string): Get current weather for a city
```

This lets the LLM decide to invoke skills with `useSkill` based on conversational context without an extra round-trip.

## Scheduler

The skill scheduler (`apps/bot/src/scheduler/skills.ts`) handles automatic execution of cron-scheduled skills.

### Polling

- Polls every 60 seconds via `setInterval` (unreferenced so it doesn't keep the process alive)
- Queries `getDueSkills()`: enabled skills where `cronSchedule` is not null and `nextRunAt <= now`, sorted by `nextRunAt` ascending
- Executes each due skill sequentially with `trigger: "cron"` and `advanceSchedule: true`

### Cron Parameter Defaults

When the scheduler fires a cron skill, it builds a parameter map from each parameter's `default` value. This is why cron-scheduled skills must have defaults for all required parameters — there is no user to supply them at execution time.

### Startup Recovery

On boot, the scheduler:

1. Resets stale running logs — any `SkillLog` with `status: "running"` and `startedAt` older than 15 minutes is marked as `failed` with summary "Process crashed during execution"
2. Immediately runs any skills that are past due (catches up after downtime)

### Concurrent Execution Guard

`isSkillRunning(skillId)` checks for any `SkillLog` with `status: "running"` and `startedAt` within the last 15 minutes. If found, the cron/manual trigger skips execution. Composed calls (`trigger: "skill"`) bypass this guard since they are controlled by the parent's step limit.

The 15-minute stale threshold ensures that crashed executions (where the log was never completed) do not permanently block the skill.

### Cron Advancement

After execution (success or failure), the next run time is computed from the **previous** `nextRunAt` slot, not from the current time. This prevents schedule drift — if a skill was due at 09:00 but executed at 09:01, the next run is computed relative to 09:00.

### Cleanup

Old skill logs (completed or failed, older than 90 days) are cleaned up by the daily cleanup routine in the proactive scheduler.

## Composability and Depth Limiting

Skills can invoke other skills via the `useSkill` tool, enabling composition:

```
Skill A (depth 0) -- useSkill --> Skill B (depth 1) -- useSkill --> Skill C (depth 2)
```

### Depth Tracking

- `MAX_SKILL_DEPTH = 3` (defined in `skill-executor.ts`)
- Each `useSkill` call increments the depth by 1
- The `useSkill` tool is only registered in the tool set when `depth < MAX_SKILL_DEPTH`
- At depth 3, the `useSkill` tool is simply absent — the LLM cannot see it or attempt to call it

### Execution Logs for Composed Calls

Composed skill executions use `trigger: "skill"` and set `parentLogId` to the calling skill's log ID. This creates a traceable tree of execution:

```
SkillLog (Skill A, trigger: "cron")
  +-- SkillLog (Skill B, trigger: "skill", parentLogId: ^)
        +-- SkillLog (Skill C, trigger: "skill", parentLogId: ^)
```

### Behavioral Differences for Composed Calls

- **No concurrency guard** — composed calls skip `isSkillRunning()` since the parent already holds execution context
- **No user notification** — composed calls return their result to the calling LLM instead of sending messages to the chat
- **Lower step limit** — 5 steps instead of 10/20, keeping sub-tasks focused
- **Synchronous return** — the calling LLM receives the skill's text output as a tool result

## File Map

| File                                      | Purpose                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `packages/db/src/models/skill.ts`         | Mongoose models (`Skill`, `SkillLog`), CRUD helpers, log helpers         |
| `apps/bot/src/ai/tools/manage-skills.ts`  | `manageSkills` tool (create/list/update/delete/enable/disable)           |
| `apps/bot/src/ai/tools/use-skill.ts`      | `useSkill` tool (invoke by name with parameters)                         |
| `apps/bot/src/services/skill-executor.ts` | `executeSkill()` — prompt assembly, `generateText()`, logging, reporting |
| `apps/bot/src/scheduler/skills.ts`        | Skill scheduler — polling, startup recovery, cron execution              |
| `apps/bot/src/services/cron.ts`           | Cron expression validation and next-run computation                      |
| `apps/bot/src/ai/tools/index.ts`          | Tool registration with depth gating                                      |
| `apps/bot/src/ai/context-assembler.ts`    | Skill context injection into system prompt                               |
| `apps/bot/src/ai/prompts.ts`              | `SKILL_BEHAVIOR_INSTRUCTIONS` constant                                   |
