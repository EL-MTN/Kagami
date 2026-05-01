# Watchers

Watchers are scheduled, stateful **detection** jobs. Where Skills are _actors_ (do things on a schedule), Watchers are _detectors_ — they observe the world, compare against a remembered last state, and notify Goshujin-sama only when a user-defined condition is met.

## When to use a watcher vs a skill

|                       | Skill                    | Watcher                                           |
| --------------------- | ------------------------ | ------------------------------------------------- |
| Purpose               | Do work                  | Detect change                                     |
| State across runs     | Stateless                | Stateful (`lastState`)                            |
| Output                | Free-form text           | Structured `{triggered, summary, newState}`       |
| Notification          | Always (or `alert` mode) | Only when `triggered === true`                    |
| Tool access           | Full                     | Read-only subset                                  |
| Composes other skills | Yes (`useSkill`)         | No (v1)                                           |
| Lifecycle             | Evergreen until disabled | Auto-archives after `expiresAt` (default 30 days) |

Use a watcher when the question is **"tell me when X happens"** — price drops, new listings, inbox events, calendar pattern changes, "is the iPhone announcement out yet."

## Architecture

```
apps/bot/src/services/watcher-executor.ts   — single-tick executor
apps/bot/src/scheduler/watchers.ts          — 60s cron poller + startup recovery
apps/bot/src/ai/tools/manage-watchers.ts    — LLM tool: create/list/update/delete/enable/disable/snooze
apps/bot/src/ai/tools/report-watcher-result.ts — terminating tool the executor parses
apps/bot/src/ai/tools/index.ts              — `watcherTools(ctx)` assembles the read-only subset
packages/db/src/models/watcher.ts           — Watcher + WatcherLog Mongoose models
```

## Data model

**`Watcher`** — owned by `chatId`, unique by `(chatId, name)` among non-archived rows:

- `prompt` — free-form detection task (target + condition)
- `cronSchedule` — required, validated by `validateCronAndDefaults`
- `lastState` — string snapshot from the previous run; fed back to the LLM next tick
- `lastFiredAt`, `fireCount` — set whenever a tick produces a real fire (not when suppressed)
- `nextRunAt` — advanced via `computeNextRunAt` anchored from `max(nextRunAt, now)`, so a long-stale slot (after downtime or a failure burst) doesn't replay the past — the next run is always strictly in the future
- `manualRunRequestedAt` — when set, the scheduler claims and executes the watcher with `silent: true` outside the cron cadence (used by the dashboard "Run now" button)
- `expiresAt` — defaults to `createdAt + 30d`, scheduler archives past this
- `archivedAt` — soft-delete, excluded from `getDueWatchers`
- `enabled` — manual disable toggle
- `oneShot` — when `true`, archive after the first real fire
- `maxFires` — when set, archive after this many real fires
- `cooldownMs` — minimum milliseconds between notifications; triggers within the window are suppressed (logged but not sent)
- `snoozedUntil` — suppress notifications until this date; detection still runs

**`WatcherLog`** — one record per tick. Captures `trigger`, `status`, `triggered`, `suppressed`, `summary`, `newState`, timestamps. `suppressed: true` means the LLM reported `triggered: true` but cooldown/snooze demoted it to a non-fire.

## Execution flow

1. Scheduler polls every 60s for due, enabled, non-archived, non-expired watchers (`getDueWatchers`).
2. For each, `executeWatcher` is invoked:
   - Skip if `isWatcherRunning` (15-min mutex via in-flight log).
   - Open a `WatcherLog` (`status: running`).
   - Build a lean detection prompt — no personality card, just last state + watcher prompt + report instructions.
   - Run `generateText` with `watcherTools(ctx)` and the `reportWatcherResult` terminator. Stop conditions: `stepCountIs(10)` or `hasToolCall("reportWatcherResult")` (whichever fires first). Temperature: `0.3`.
   - Parse `reportWatcherResult` tool call from `result.steps`. Missing → fail the log.
   - Track token usage under category `"watcher"`.
   - **Evaluate the trigger** via `evaluateTrigger(watcher, reported, now)`:
     - `"none"` — `triggered: false`. Just roll `lastState` forward via `recordWatcherStateOnly`.
     - `"suppress"` — `triggered: true` but inside `snoozedUntil` or `cooldownMs` window. Same `lastState` update, log marked `suppressed: true`, no notification.
     - `"fire"` — real fire. Update `lastState`, increment `fireCount`, set `lastFiredAt`, send notification, then check `oneShot` / `maxFires` for auto-archive.
   - Advance `nextRunAt` (anchored from `max(nextRunAt, now)` — see Data model).
3. On execution failure: log marked `failed`, cron still advanced, error notified to user.
4. On startup: `resetStaleRunningWatcherLogs()` recovers crashes; `archiveExpiredWatchers()` retires past-`expiresAt` records.

### Suppression rules (priority order)

1. `snoozedUntil` set and `now < snoozedUntil` → suppress.
2. `cooldownMs` set and `(now − lastFiredAt) < cooldownMs` → suppress.
3. Otherwise → fire.

Suppression preserves observation accuracy (`lastState` still rolls forward) while bounding user noise. Snoozed/cooled-down windows still consume tokens (the LLM still runs); to fully pause a watcher, use `disable` instead.

## Tool surface inside watchers (read-only)

`watcherTools(ctx)` exposes:

- `browse` — read-only variant (`createReadOnlyBrowseTool()`); only `search`/`visit`/`extract` are permitted (no `screenshot`, `act`, `agent`, `login`)
- `searchMemory`, `readMemory`, `listMemories`
- `checkEmail` (gated on `GOOGLE_OAUTH_CLIENT_ID`)
- `listCalendarEvents` — `createManageCalendarTool({ mode: "readOnly" })` returns a list-only tool
- `useSkill` — gated to read-purity skills via `callingContext: "watcher"`. Action-purity skills are rejected with a clear error.
- `reportWatcherResult` — required terminator

Explicitly excluded: `sendEmail`, `rememberFact`, `noteToSelf`, `manageReminders`, `sendPhoto`, `sendVoice`, `manageSkills`, `manageWatchers`. The principle: watchers observe; action belongs to the trigger handler. This bounds blast radius — a misfiring detection produces a spurious message, never a sent email or modified calendar.

### Skill purity

Skills carry a `purity: "read" | "action"` marker (default `"action"` for backward-compat safety). The watcher invariant is enforced in two layers:

- **`useSkill` gate** — only `purity: "read"` skills are invocable from `callingContext: "watcher"`. Action skills return `{ success: false, reason: "..." }` without executing.
- **Tool-palette restriction** — when a skill _runs_ under `callingContext: "watcher"` (i.e., it was invoked by a watcher), the skill executor uses the read-only tool subset (`skillToolsUnderWatcher`) instead of `allTools`. The skill cannot send emails, write to memory, modify the calendar, or otherwise mutate external state through its own tool palette. This makes the read-only invariant **transitive**: a misbehaving read-purity skill can't leak mutations even if its prompt instructs otherwise.

`callingContext` propagates through `executeSkill` → `useSkill` → next `executeSkill`, so the gate stays watcher-scoped at every hop.

Authors mark skills explicitly via `manageSkills` (LLM tool) or the dashboard skill editor's Purity field.

## Creation

Conversational creation through the `manageWatchers` tool, available in main chat and inside skill executors. Skills can create watchers; **watchers cannot create watchers** (the tool is omitted from `watcherTools`).

```
Goshujin-sama: "Watch HN front page for posts about Anthropic, check hourly."
Mashiro:        manageWatchers({ action: "create", name: "hn-anthropic", ... })
```

### Dashboard

The Next.js dashboard at `/watchers` mirrors the Skills surface:

- List view (`apps/dashboard/src/app/watchers/page.tsx`) — search, filter (all / enabled / snoozed), enabled toggle, delete, create, import, export.
- Detail editor (`apps/dashboard/src/app/watchers/[id]/page.tsx`) — inline edits to name/description/prompt/cron, lifecycle controls (oneShot, maxFires, cooldownMinutes), snooze dropdown, manual "Run now" button (sets `manualRunRequestedAt`; the scheduler's 3s manual-run poll claims it and runs the watcher with `silent: true`), state-change timeline (see below), and full execution log with triggered/silenced/failed verdicts.
- **State-change timeline** (`apps/dashboard/src/components/watchers/state-timeline.tsx` + `getWatcherStateHistory(watcherId, limit)` in `lib/queries/watchers.ts`): walks the most recent `limit` completed runs, collapses consecutive identical `newState` values, and renders one entry per _distinct_ observation. Markers are shape-coded — filled disc for triggered fires, hollow ring for cooldown/snoozed-suppressed fires, hairline tick for routine observations. Each entry shows the prior state inline as a struck-through "Was" block when it differs from the current state. Sort is reverse-chronological (newest first); the query fetches the newest window so a long history doesn't drop recent transitions.
- API: `/api/watchers` (CRUD + import), `/api/watchers/[id]/run` (manual trigger), `/api/watchers/[id]/logs`, `/api/watchers/export`. All routes import directly from `@mashiro/db`.

## Deferred

Still on the backlog (not in v2):

- `onTriggerSkill` field — invoke a named skill on trigger. Blocked on an approval-workflow shim for write tools; without it, a misfiring watcher could send unintended emails.
- Extracted `ScheduledRunner` primitive shared with the skill scheduler — duplicate first, extract once a third caller arrives.
