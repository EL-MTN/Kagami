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
apps/bot/src/ai/tools/manage-watchers.ts    — LLM tool: create/list/update/delete/enable/disable
apps/bot/src/ai/tools/report-watcher-result.ts — terminating tool the executor parses
apps/bot/src/ai/tools/index.ts              — `watcherTools(ctx)` assembles the read-only subset
packages/db/src/models/watcher.ts           — Watcher + WatcherLog Mongoose models
```

## Data model

**`Watcher`** — owned by `chatId`, unique by `(chatId, name)`:

- `prompt` — free-form detection task (target + condition)
- `cronSchedule` — required, validated by `validateCronAndDefaults`
- `lastState` — string snapshot from the previous run; fed back to the LLM next tick
- `lastFiredAt`, `fireCount` — set whenever a tick reports `triggered: true`
- `nextRunAt` — advanced via `computeNextRunAt` anchored from `max(nextRunAt, now)`, so a long-stale slot (after downtime or a failure burst) doesn't replay the past — the next run is always strictly in the future
- `expiresAt` — defaults to `createdAt + 30d`, scheduler archives past this
- `archivedAt` — soft-delete, excluded from `getDueWatchers`
- `enabled` — manual disable toggle

**`WatcherLog`** — one record per tick. Captures `trigger`, `status`, `triggered`, `summary`, `newState`, timestamps.

## Execution flow

1. Scheduler polls every 60s for due, enabled, non-archived, non-expired watchers (`getDueWatchers`).
2. For each, `executeWatcher` is invoked:
   - Skip if `isWatcherRunning` (15-min mutex via in-flight log).
   - Open a `WatcherLog` (`status: running`).
   - Build a lean detection prompt — no personality card, just last state + watcher prompt + report instructions.
   - Run `generateText` with `watcherTools(ctx)` and the `reportWatcherResult` terminator. Stop conditions: `stepCountIs(10)` or `hasToolCall("reportWatcherResult")` (whichever fires first). Temperature: `0.3`.
   - Parse `reportWatcherResult` tool call from `result.steps`. Missing → fail the log.
   - Track token usage under category `"watcher"`.
   - Complete the log; update `watcher.lastState` (and `lastFiredAt`/`fireCount` if triggered).
   - Advance `nextRunAt` (anchored from `max(nextRunAt, now)` — see Data model).
   - **Send notification only when `triggered === true`** via `sendSegmented(adapter, chatId, formatTriggerMessage(watcher, summary))`.
3. On execution failure: log marked `failed`, cron still advanced, error notified to user.
4. On startup: `resetStaleRunningWatcherLogs()` recovers crashes; `archiveExpiredWatchers()` retires past-`expiresAt` records.

## Tool surface inside watchers (read-only)

`watcherTools(ctx)` exposes only:

- `browse` (gated on `BROWSER_ENABLED`)
- `searchMemory`, `readMemory`, `listMemories`
- `checkEmail` (gated on `GOOGLE_OAUTH_CLIENT_ID`)
- `listCalendarEvents` — `createManageCalendarTool({ mode: "readOnly" })` rejects non-`list` actions
- `reportWatcherResult` — required terminator

Explicitly excluded: `sendEmail`, `rememberFact`, `noteToSelf`, `manageReminders`, `sendPhoto`, `sendVoice`, `manageSkills`, `manageWatchers`, `useSkill`. The principle: watchers observe; action belongs to the trigger handler. This bounds blast radius — a misfiring detection produces a spurious message, never a sent email or modified calendar.

## Creation

Conversational creation through the `manageWatchers` tool, available in main chat and inside skill executors. Skills can create watchers; **watchers cannot create watchers** (the tool is omitted from `watcherTools`).

```
Goshujin-sama: "Watch HN front page for posts about Anthropic, check hourly."
Mashiro:        manageWatchers({ action: "create", name: "hn-anthropic", ... })
```

No dashboard creation form in v1.

## Deferred (v2)

- `onTriggerSkill` field — invoke a named skill on trigger. Requires an approval workflow for write tools first; without it, a misfiring watcher could send unintended emails.
- `useSkill` from inside watchers — requires a `purity` marker on skills so only read-marked ones are callable from a read-only context.
- Snooze, cooldown, escalation, `oneShot`, `maxFires`.
- Dashboard creation form / detail editor / log viewer.
- Extracted `ScheduledRunner` primitive shared with the skill scheduler — duplicate first, extract once a third caller arrives and the shared shape is obvious.
