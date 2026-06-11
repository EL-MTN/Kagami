# Confirmations

Approval primitive for risky tool calls. Mashiro can ask Goshujin-sama to tap-approve an externally-visible or irreversible action before it runs. The runtime guarantees that anything routed through the primitive only fires after a button press.

## When to use

Gate any action you wouldn't want to misfire. Coverage today: `sendEmail`, mutating `manageCalendar` actions (`update`/`delete`), `browseAgent` (the autonomous browse mode), and the Kizuna CRM writes (`logInteraction`, `createFollowup`, `resolveFollowup`, `updatePerson`). Every gated mutation is **code-enforced**: each tool's `execute` body refuses direct invocation with an envelope pointing at `requestConfirmation`, so the gate holds even if prompt guidance fails. The one carve-out is `sendEmail`'s note-to-self path — a send addressed to the authenticated Gmail account itself (`getOwnerAddress`, profile lookup cached per vended access token — a Kao re-consent to a different account invalidates immediately) with no cc/bcc executes directly; anything else is refused. `browseAgent` needs no refusal because it has no inline tool — autonomous browsing exists only as a dispatchable action. The inline `browse` `act` action remains direct (single-step page interaction), but the tool description and prompt guidance route purchases / form submissions / irreversible page actions through the `browseAgent` confirmation.

| Use directly                                 | Wrap in `requestConfirmation`                          |
| -------------------------------------------- | ------------------------------------------------------ |
| Reading email / listing calendar             | Sending email to anyone but Goshujin                   |
| Self-addressed drafts / notes                | `manageCalendar` with `action: "update"` or `"delete"` |
| Setting reminders                            | `browseAgent` (autonomous multi-step browser)          |
| Saving facts (`rememberFact`)                | Replying to a thread on his behalf                     |
| `browse` search/visit/extract/act/screenshot | Kizuna CRM writes: `logInteraction`, `createFollowup`, |
| Kizuna CRM reads (`findPeople`, etc.)        | `resolveFollowup`, `updatePerson`                      |

The gated allowlist is the single source of truth at `apps/bot/src/services/gated-actions.ts::GATED_TOOL_NAMES`. The `requestConfirmation` tool's `action.tool` parameter is a Zod enum bound to that list — the LLM cannot route a non-gated tool through the wrapper.

## Why a primitive (vs. blanket gating)

1. **Routines can't pause.** A routine's `generateText` call can't block waiting for a button press for hours. The primitive flips the model: persist the intent, return immediately, resume on approval. Routines exit cleanly with "pending"; the user's button press triggers dispatch out-of-band.
2. **The LLM picks the moment.** Self-addressed drafts, low-stakes replies, and high-stakes outbound mail all share the same `sendEmail` tool. Forcing every send through approval would be noise. Letting the LLM decide preserves natural flow while keeping a hard gate on the cases that matter.

## Flow

```
User: "send Alice an email saying we're meeting at 3pm"
  │
  ├─► Mashiro calls requestConfirmation({
  │       summary: "send email to alice@x.com about 3pm meeting",
  │       action: { tool: "sendEmail", args: { to, subject, body } }
  │   })
  │
  ├─► tool: persists PendingConfirmation row
  ├─► tool: adapter.sendConfirmationPrompt(chatId, text, id)
  │         → Telegram message with [✓ Approve][✗ Deny] buttons
  ├─► tool: returns { pending: true, confirmationId }
  ├─► Mashiro stops; sends short text like "lemme know"
  │
  │  ─── time passes; the pending row appears in her system prompt under
  │      "## Pending Approvals" so subsequent turns don't re-prompt ───
  │
  ├─► User taps Approve
  ├─► Telegram callback_query: data = "confirm:<id>:approve"
  ├─► platform/telegram/bot.ts callback handler:
  │     1. Load PendingConfirmation, validate (chat-scoped, status, expiry)
  │     2. resolvePendingConfirmation(id, "approved")  ← atomic, BEFORE dispatch
  │     3. answerCallbackQuery({ text: "Working…" })   ← dismiss spinner
  │     4. dispatchGatedAction(action.tool, action.args) → { success, summary }
  │     5. attachResultText(id, summary)
  │     6. editConfirmationPrompt → "✓ Approved · email sent to alice@x.com"
  │     7. appendConfirmationResolution → "[goshujin-sama approved: … — done]"
  │     8. generateAcknowledgment (fire-and-forget) → Mashiro speaks one bubble in character
  │
  └─► Mashiro: "done, sent it~"
```

Denial is symmetric minus the dispatch step. Expiration (24h default) writes `status: "expired"` and runs the same edit + answer-query cycle. Most expired rows are physically deleted by the MongoDB TTL index before anyone interacts with them; the `"expired"` status is only written when a user happens to tap a stale prompt button after the TTL window.

### Race safety

The atomic transition runs **before** dispatch. A second click that arrives mid-dispatch finds `status !== "pending"` and bows out without re-dispatching. The acknowledgment of the original click happens immediately via `answerCallbackQuery({ text: "Working…" })`, so the Telegram button spinner doesn't sit through long-running actions like `browseAgent`.

### Acknowledgment turn

After dispatch settles and the bracketed resolution event is appended to conversation history, the callback handler kicks off `generateAcknowledgment(chatId, userId, adapter)` as fire-and-forget. This is a one-shot LLM turn that:

- Reuses the regular system prompt (so personality, memory, pending-approvals context are all loaded)
- Appends the acknowledgment-turn instructions from `apps/bot/context/instructions/acknowledgment.md` (loaded via `readInstruction("acknowledgment")`) directing a single short in-character bubble
- Runs with no tools — a single in-character speaking turn (the tool set is withheld rather than capped by a step count), 60s timeout, temperature 0.6
- Tracks token usage under category `conversation`

If the turn fails, the bracketed event still lives in conversation history, so Mashiro can reference the resolution on the next user message anyway.

## Pending in system prompt

`assemblePendingConfirmationsContext(chatId)` queries `listPendingConfirmations` and renders a `## Pending Approvals` section into both `assembleSystemPrompt` and `assembleProactiveSystemPrompt`. Each row shows: age, summary, id, and a stale-warning if older than 60 minutes. The trailing instruction tells the LLM not to re-prompt for the same action and to use `cancelConfirmation` if Goshujin-sama wants to abort.

## Cancelling from chat

`cancelConfirmation({ confirmationId, reason? })` is the LLM-side counterpart to the Deny button. It atomically transitions the row to `"cancelled"` (a distinct terminal status from `"denied"`, since cancelled-by-Mashiro is semantically different from denied-by-user), edits the prompt bubble in place, and appends a `[mashiro cancelled pending request: …]` event to conversation history.

The tool is registered alongside `requestConfirmation` whenever any gated underlying tool is configured.

## Data model

`PendingConfirmation` (MongoDB, TTL on `expiresAt`):

| Field             | Type                                                                                                                                                                                                                                                                                                               | Description                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chatId`          | string                                                                                                                                                                                                                                                                                                             | Telegram chat                                                                                                                                                                              |
| `summary`         | string                                                                                                                                                                                                                                                                                                             | One-line user-facing description; shown on the prompt and in the event                                                                                                                     |
| `action.tool`     | `"sendEmail" \| "manageCalendar" \| "browseAgent" \| "logInteraction" \| "createFollowup" \| "resolveFollowup" \| "updatePerson"` — or a dispatch-only name (`"createRoutine"`, `"createSkill"`, `"updateRoutinePrompt"`, `"disableRoutine"`, `"updateSkill"`, `"disableSkill"`, `"mergeSkills"`, `"executeCode"`) | Tool name. Gated names are validated against `GATED_TOOL_NAMES` at both ends; dispatch-only names are raisable only by their dedicated tool/proposal core, never via `requestConfirmation` |
| `action.args`     | mixed                                                                                                                                                                                                                                                                                                              | Tool args; re-validated by Zod at dispatch time                                                                                                                                            |
| `status`          | `"pending" \| "approved" \| "denied" \| "expired" \| "cancelled"`                                                                                                                                                                                                                                                  | State machine                                                                                                                                                                              |
| `origin`          | `"conversation" \| "routine" \| "watcher"`                                                                                                                                                                                                                                                                         | Where the request came from (watchers can't author, but reserved)                                                                                                                          |
| `originRef`       | string?                                                                                                                                                                                                                                                                                                            | Reserved for routine/watcher id when those origins are wired                                                                                                                               |
| `promptMessageId` | string?                                                                                                                                                                                                                                                                                                            | Telegram message id, used for in-place editing                                                                                                                                             |
| `resultText`      | string?                                                                                                                                                                                                                                                                                                            | Outcome text, set after dispatch settles — the dispatch's fuller `resultText` (e.g. executeCode's program output) when present, else its one-line summary                                  |
| `expiresAt`       | Date                                                                                                                                                                                                                                                                                                               | Default `+24h`; MongoDB TTL index auto-removes after this                                                                                                                                  |
| `resolvedAt`      | Date?                                                                                                                                                                                                                                                                                                              | When transitioned out of `pending`                                                                                                                                                         |

Atomic transitions live in `resolvePendingConfirmation(id, verdict, resultText?)` — a `findOneAndUpdate` with `status: "pending"` in the filter. Double-clicks and racing handlers get a null result and bow out cleanly.

## Tool surface

`requestConfirmation({ summary, action: { tool, args } })` and `cancelConfirmation({ confirmationId, reason? })` are both always registered in `allTools(ctx)` (CRM writes and `browseAgent` are always-present gated tools). Excluded from `watcherTools` (watchers can't mutate) and `routineToolsUnderWatcher` (transitive read-only invariant).

## Adapter contract

`PlatformAdapter` gains two methods that any future channel must implement:

- `sendConfirmationPrompt(chatId, text, confirmationId): Promise<string | undefined>` — post a message with [Approve][Deny] buttons; return the platform message id.
- `editConfirmationPrompt(chatId, messageId, text): Promise<void>` — replace the body with a terminal-state line and remove the keyboard.

Telegram implementation in `apps/bot/src/platform/telegram/adapter.ts` uses Grammy's `InlineKeyboard` with callback data `confirm:<id>:<approve|deny>`. The callback handler in `apps/bot/src/platform/telegram/bot.ts` parses that pattern (regex: `/^confirm:([a-f0-9]{24}):(approve|deny)$/`).

## Adding a gated tool

1. Append the name to `GATED_TOOL_NAMES` in `apps/bot/src/services/gated-actions.ts`.
2. Add a Zod schema entry in `GATED_ARG_SCHEMAS` (the schema may narrow the action set — e.g., `manageCalendar` only accepts `update` and `delete`).
3. Add a `case` in `dispatchGatedAction`'s switch — call the underlying service, return `{ success, summary, detail }`.
4. Update the prompt guidance in `apps/bot/context/instructions/maid-service.md` so the LLM knows when to gate.

The tool's underlying service stays untouched; the dispatcher calls it directly with validated args.

### Dispatch-only actions (not LLM-raisable)

Some actions should be executable through the approval rail but **not** selectable by the model via `requestConfirmation`. The proposal-backed actions — `createRoutine`, `updateRoutinePrompt`, `disableRoutine` (routine save/refine/retire), `createSkill`, `updateSkill`, `disableSkill`, `mergeSkills` (skill save/refine/archive/merge) — live in `DISPATCH_ONLY_TOOL_NAMES`, not `GATED_TOOL_NAMES`, so they are **absent from `requestConfirmation`'s enum**. The model cannot raise them directly and bypass the proposal-specific anti-nag guards; every one is reachable only through its proposal core (`proposeRoutine`, `proposeRoutineRefinement`/`proposeRetirement`, `proposeSkill`, or the skill-curation cores in `skill-refinements.ts`) → `raiseGuardedProposal` → `raisePendingConfirmation` → approve. `raisePendingConfirmation` is the single rail writer extracted from `requestConfirmation` so both paths share identical create → send → `setPromptMessageId` plumbing (including the failure paths: if the prompt **send** fails, the freshly-created row is cancelled before the error propagates — a bubble the user never saw must not linger as an invisible, unapprovable pending row; if only the post-send `setPromptMessageId` write fails, the row stays pending — the bubble is on screen and the Telegram callback handler falls back to the callback's own message id, so the worst case is a bubble that can't be edited in place); proposals pass a shorter `ttlMs` (`PROPOSAL_TTL_MS`, owned by `apps/bot/src/ai/tools/proposal-guard.ts`), a `promptText` that shows the full proposed artifact, and the shared one-pending guard, which suppresses (`suppressedByPending: true`, transient) while **any** confirmation is pending in the chat — a gated action like `sendEmail` just as much as another proposal — because the iMessage YES/NO parser resolves only when exactly one confirmation is pending, so a proposal stacked behind anything else would wedge both. On deny/cancel, the platform callback calls `recordProposalDeclineFromConfirmation(row)`, which discriminates on `action.tool` (not origin, so a routine-raised gated action never trips it — the `ROUTINE_PROPOSAL_TOOLS` / `SKILL_PROPOSAL_TOOLS` sets route each tool) and records the decline in the routine or skill proposal store. See [ai-layer.md](ai-layer.md#proposeroutine-live-conversational-turns-only) and [skills.md](skills.md).

`executeCode` is also dispatch-only, but for a different reason: the user must review the **program body**, not a summary. The dedicated `executeCode` tool (`apps/bot/src/ai/tools/execute-code.ts`, registered only when `EXECUTE_CODE_ENABLED` is set) raises the confirmation itself via `raisePendingConfirmation` with the full code as a fenced block in `promptText` — the schema caps code at 3000 chars precisely so the **entire** program always fits in the bubble; there is no truncated preview an executable suffix could hide behind. The fence is dynamically lengthened past any backtick run inside the code (so an embedded ```can't close the block early), backticks are stripped from the model-supplied `description` that sits above the fence (so it can't open a block that pairs into the program's fence and breaks the verbatim rendering), NUL- and bidi-control-bearing code is refused outright (the formatter strips NULs before rendering, and bidi controls render visually reordered — Trojan-Source style — so the displayed program would differ from the one that executes; both refusals are mirrored at the dispatch boundary), and a pre-raise guard refuses code whose grown prompt would exceed Telegram's 4096-char message cap — refusing costs one tool-error turn, while raising-then-failing-the-send would orphan a row. If`executeCode`lived in`GATED_TOOL_NAMES`, the model could route it through `requestConfirmation`and the user would approve a ≤400-char`summary`without ever seeing the code. On approve, the dispatcher re-checks`EXECUTE_CODE_ENABLED`(pending rows live up to 24h — a flag flip must also stop already-raised approvals), re-validates the args (language enum + the same 3000-char cap), logs only`{ language, codeLength }` — never the code body, so nothing pasted into a script reaches Kansoku (the Telegram adapter also redacts the prompt text from grammY send errors before logging or rethrowing them, since grammY attaches the full request payload to its errors) — and runs it in the ephemeral Docker sandbox (`apps/bot/src/services/code-sandbox.ts`). There is no decline store: a denied run is just dropped.

## On non-button platforms

iMessage has no inline buttons and no third-party message editing. The confirmation primitive degrades gracefully: `sendConfirmationPrompt` sends a plain text prompt asking the user to reply YES/NO; `editConfirmationPrompt` sends a new message instead of editing the original bubble. The pre-AI YES/NO parser in the iMessage webhook handler resolves the confirmation when there's exactly one pending in the chat. See [imessage.md](imessage.md) for the full UX and matching rules.

## Dashboard surface

`/confirmations` (`apps/dashboard/src/app/confirmations/page.tsx`) is a tabbed view (`?view=pending` default, `?view=history` for the most recent 50 resolved). Each card surfaces origin (conversation / routine / watcher), tool name, args (expandable JSON), expiry countdown for pending rows, and the resolution result for resolved rows — rendered by `apps/dashboard/src/components/confirmation-card.tsx`. The sidebar count badge is sourced from `getPendingConfirmationCount()`. The Overview page (`apps/dashboard/src/app/page.tsx`) previews the top three pending rows with a caution badge in the page header.

Queries live in `apps/dashboard/src/lib/queries/confirmations.ts`: `getPendingConfirmationList()`, `getRecentResolvedConfirmations(limit)`, `getPendingConfirmationCount()`.

## What's deferred

- **Routines as origin.** The `origin: "routine"` value exists in the schema but the routine executor doesn't yet pass it through `requestConfirmation`. Routines can still call the tool — they just currently report origin `"conversation"`.
- **Idempotency window.** Two `requestConfirmation` calls with the same `(chatId, tool, hash(args))` produce two separate rows. Should dedupe within ~60s.
- **Expiry notification.** TTL-expired rows rot silently; no message is posted to the user.
