# Architecture

## System Overview

Kokoro is a layered conversational AI system organized as a monorepo. Messages flow from a platform adapter through normalization, storage, context assembly, LLM generation, and back out as responses.

### Monorepo Layout

Kokoro lives at `Kagami/kokoro/` as a subtree of the **Kagami nested monorepo**. The top-level `package.json`, `turbo.json`, `package-lock.json`, and Husky hooks live at the Kagami root — not inside `kokoro/`. Shared lint and tsconfig bases come from `@kagami/eslint-config` and `@kagami/tsconfig` in `Kagami/shared/packages/`.

```
kokoro/                          # subtree of Kagami workspace (npm workspaces + Turborepo)
├── apps/
│   ├── bot/                      # Telegram + iMessage bot app
│   │   ├── src/
│   │   │   ├── ai/               # provider, prompts, response, context-assembler, generate, acknowledge, token-tracker
│   │   │   │   └── tools/        # tool files grouped by domain (memory, CRM, media, email, calendar, browse, web-search, routines, watchers, confirmations)
│   │   │   ├── context/          # image generation (generator.ts, types.ts)
│   │   │   ├── platform/         # registry.ts + telegram/ + imessage/ (multi-adapter)
│   │   │   ├── services/         # google-auth, gmail, google-calendar, browser, web-search, routine-executor, watcher-executor, location, geocoding, gated-actions, confirmation-events
│   │   │   ├── scheduler/        # proactive, reminders, routines, watchers, maintenance (cleanup + Kioku sweepers)
│   │   │   ├── stt/              # speech-to-text (cloud Whisper / local whisper.cpp)
│   │   │   └── tts/              # text-to-speech generation
│   │   └── context/              # soul.md (personality), instructions/*.md (operational), reference images, settings, image-prefix (data)
│   └── dashboard/                # Next.js dashboard (routine + watcher management, observability)
├── packages/
│   ├── shared/                   # config, logger, markdown, types
│   ├── db/                       # MongoDB connection, models, GridFS
│   ├── memory/                   # Kioku HTTP client + transcript/fact glue + sweepers
│   ├── kizuna/                   # Kizuna read-only CRM client + compact projections
│   └── test-utils/               # Vitest harness (withTestDb, fakeAdapter, MSW)
├── scripts/                      # auth
├── vitest.config.ts              # workspace-local vitest config (still here)
└── docs/
```

### Dependency Graph

```
@kokoro/shared  ← config, logger, markdown, types (dotenv, zod, pino, gray-matter)
       ↑              ↑              ↑
@kokoro/db      @kokoro/memory  @kokoro/kizuna
Mongo/GridFS    Kioku client    Kizuna CRM client
       ↑              ↑              ↑
@kokoro/bot     ← AI layer, tools, platform, schedulers
@kokoro/dashboard ← Next.js (routine + watcher management, observability)
```

Tooling bases (`@kagami/eslint-config`, `@kagami/tsconfig`) come from the Kagami workspace and are consumed via `extends` in each tsconfig and ESLint config.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│            Platform Adapters                         │
│   Telegram (Grammy) + iMessage (BlueBubbles)         │
│        allowlist ─► rate limit ─► handlers           │
└──────────────┬──────────────────────┬────────────────┘
               │ IncomingMessage      │ sendText/sendPhoto
               ▼                      ▲
┌──────────────────────────────────────────────────────┐
│                   AI Layer                            │
│              (apps/bot/src/ai/)                       │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │   generate    │  │   context    │  │  response   │ │
│  │  (handler)    │──│  assembler   │  │  utilities  │ │
│  └──────┬───────┘  └──────┬───────┘  └────────────┘ │
│         │                 │                          │
│  ┌──────┴───────┐  ┌──────┴───────┐                 │
│  │    tools/     │  │   prompts    │                 │
│  │ searchMemory  │  │  (system +   │                 │
│  │ rememberFact  │  │   format)    │                 │
│  │ CRM tools     │  └──────────────┘                 │
│  │ sendPhoto     │                                    │
│  │ sendVoice     │                                    │
│  │ email/cal/    │                                    │
│  │   reminders   │                                    │
│  │ browse        │                                    │
│  │ webSearch     │                                    │
│  │ routines      │                                    │
│  │ watchers      │                                    │
│  │ confirmations │                                    │
│  └──────┬───────┘                                    │
└─────────┼────────────────────────────────────────────┘
          │
   ┌──────┴───────────┬───────────────────┐
   ▼                  ▼                   ▼
┌──────────┐  ┌────────────┐  ┌──────────────────┐
│ MongoDB  │  │@kokoro/    │  │  Kioku service   │
│          │  │memory      │  │  (separate proc) │
│Conv'n    │──│  HTTP      │─►│                  │
│Scheduler │  │  client +  │  │ /facts /recall   │
│State     │  │  transcript│  │ /sessions /query │
│Reminder  │  │  + sweeper │  │ /mcp             │
│Routine   │  └────────────┘  │                  │
│RoutineLog│                  │ facts.jsonl      │
│TokenUsage│                  │ entities.jsonl   │
│Location  │                  │ hybrid retrieval │
│History   │                  └──────────────────┘
│Pending   │                  KIOKU_URL (default
│Confirm   │                  https://api.kioku.localhost)
└──────────┘

┌────────────┐     ┌──────────────────┐
│@kokoro/    │     │  Kizuna service  │
│kizuna HTTP │────►│ /people       │
│client      │     │ /interactions │
│            │     │ /followups    │
└────────────┘     └──────────────────┘
KIZUNA_URL
(default https://api.kizuna.localhost)

┌──────────────────────────┐
│   Proactive Scheduler    │    ← apps/bot/src/scheduler/proactive.ts
│                          │
│ timers ─► idle check     │
│        ─► active hours   │
│        ─► generate msg   │
│        ─► persist state  │
└──────────────────────────┘

┌──────────────────────────┐
│   Maintenance Scheduler  │    ← apps/bot/src/scheduler/maintenance.ts
│                          │
│ daily cleanup            │
│  (reminders, conv'ns,    │
│   routine + watcher logs,│
│   location history)      │
│ Kioku sweepers           │
│  (5 min tick: stale-     │
│   active, pending ingest │
│   + queued fact retries) │
└──────────────────────────┘

┌──────────────────────────┐
│   Reminder Scheduler     │
│                          │
│ poll 60s ─► pending?     │
│           ─► send text   │
│           ─► mark fired  │
│ startup recovery         │
└──────────────────────────┘

┌──────────────────────────┐
│   Routine Scheduler        │    ← apps/bot/src/scheduler/routines.ts
│                          │
│ poll 60s ─► due?         │
│           ─► execute     │
│           ─► log result  │
│           ─► advance cron│
│ startup recovery         │
│ stale lock cleanup       │
└──────────────────────────┘

┌──────────────────────────┐
│   Watcher Scheduler      │    ← apps/bot/src/scheduler/watchers.ts
│                          │
│ poll 60s ─► due?         │
│           ─► detect      │
│           ─► diff vs     │
│              lastState   │
│           ─► notify only │
│              on trigger  │
│ archive expired          │
│ stale lock cleanup       │
└──────────────────────────┘

┌──────────────────────────┐
│   Google Services        │    ← apps/bot/src/services/
│                          │
│ OAuth2 singleton         │
│  ─► Gmail (read-only)    │
│  ─► Calendar (CRUD)      │
│  (conditional on config) │
└──────────────────────────┘

┌──────────────────────────┐
│   Image Generation       │    ← apps/bot/src/context/
│                          │
│ reference loader         │
│  ─► face/body/outfit     │
│     + setting pick       │
│  ─► provider/model from  │
│     IMAGE_GENERATION_    │
│     MODEL (e.g. xai/     │
│     grok-imagine-image)  │
│  ─► buffer ─► send       │
└──────────────────────────┘
```

## Message Flow

```
1. User sends message on Telegram or iMessage
       │
2. Platform handler fires (message:text, message:photo, or message:location)
       │
3. Allowlist check ─► Rate limit check
       │
4. adapter.normalize(ctx) → IncomingMessage
       │  (for photos: download file, convert to base64)
       │  (for voice: transcribe via STT before reaching the AI layer)
       │
5. getOrCreateSession(chatId) — idle-based (1h threshold)
       │  ├─ If stale session found: close it, return previouslyClosed
       │  └─ Return active session with sessionId
       │
6. If previouslyClosed: ingestClosedSession(prev) — fire-and-forget
       │   POST the transcript to Kioku /sessions; doesn't block this turn.
       │   On success → conversation.ingestStatus flips pending → done.
       │   On failure → sweeper retries within 5 min.
       │
7. If image: write to GridFS → get imageRef key
       │
8. appendMessage(conversation, userMsg with imageRef)
       │
9. Parallel: assembleSystemPrompt(chatId) + assembleMessages(chatId)
       │   ├─ System: soul.md + current mood + datetime + instructions/*.md + reminders + location
       │   │         (no facts pre-loaded — Mashiro calls searchMemory on demand)
       │   └─ Messages: last 40 msgs from active session, images from GridFS,
       │                tool-call pairs (recent 10 only)
       │
10. generateText({ model, system, messages, tools, stopWhen: stepCountIs(5), temperature: 0.7 })
       │   └─ LLM may call tools (searchMemory, rememberFact, sendPhoto, sendEmail, etc.)
       │       searchMemory → @kokoro/memory.recall() → POST Kioku /recall
       │       rememberFact → @kokoro/memory.appendFactWithRetryQueue() → POST Kioku /facts
       │       CRM tools → @kokoro/kizuna → GET Kizuna /* read-only endpoints
       │
11. extractResponseText(steps) + collectToolCalls(steps)
       │
12. appendMessage(conversation, assistantMsg with toolCalls)
       │
13. sendSegmented(adapter, chatId, text) — split on \n\n
       │   (skipped if sendPhoto already delivered a photo)
       │
14. resetTimer(chatId) — reschedule proactive message
```

See [memory.md](memory.md) for the Kioku read/write paths in full, including the sweepers that backstop fire-and-forget ingest failures and queued one-off fact writes.

## Proactive Scheduler

The scheduler sends unprompted messages to maintain engagement:

- **Active hours**: 9:00 AM – 1:00 AM (outside → reschedule to next 9 AM)
- **Idle requirement**: user must be idle >= 1 hour before firing
- **Intervals**: 1.5–2.5 hours between proactive messages
- **Startup**: 30–60 minute delay after boot
- **Persistence**: next-fire timestamps saved to MongoDB (survives restarts)
- **Reset**: any user message reschedules the next proactive to 1.5–2.5h out

When firing, the scheduler uses `getOrCreateSession` to get the active session, assembles a proactive system prompt with sessionId, and injects a synthetic nudge if no recent user message exists.

Daily cleanup and the Kioku sweepers used to live here, but have been extracted into the **Maintenance Scheduler** (`apps/bot/src/scheduler/maintenance.ts`):

- **Kioku sweepers**: every 5 minutes, drive any `closed && ingestStatus: "pending"` conversations to `done`, close `active` sessions idle past the threshold so they become eligible for ingest, and retry queued one-off facts from `rememberFact` or location learning. See [memory.md](memory.md).
- **Daily cleanup**: removes fired reminders (>30 days), closed conversations (>90 days), old routine logs (>90 days), old watcher logs (>90 days), and old location history (>90 days).

## Package Boundaries

| Package             | Purpose                                              | Key Exports                                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kokoro/shared`    | Config, logging, markdown, platform types            | `config`, `validateConfig`, `logger`, `parseMarkdown`, `haversineMeters`, `IncomingMessage`, `PlatformAdapter`, `computeNextRunAt`, `validateCronAndDefaults`                                                                                                                    |
| `@kokoro/db`        | MongoDB connection, all models, GridFS               | `connectDB`, `disconnectDB`, `Conversation`, `PendingFact`, `Reminder`, `SchedulerState`, `TokenUsage`, `Routine`, `RoutineLog`, `Watcher`, `WatcherLog`, `LocationHistory`, `PendingConfirmation`, `readImage`/`writeImage`, `readAudio`/`writeAudio`, all model CRUD functions |
| `@kokoro/memory`    | Kioku HTTP client + conversation/fact retry glue     | `recall`, `appendFact`, `appendFactWithRetryQueue`, `getFactById`, `getFactCount`, `hasFactsForSession`, `ingestSession`, `buildTranscript`, `ingestClosedSession`, `sweepPendingIngests`, `sweepPendingFacts`, `sweepStaleActiveSessions`, `KiokuClientError`                   |
| `@kokoro/kizuna`    | Kizuna read-only CRM client + compact projections    | `findPeople`, `getPerson`, `getPersonContext`, `recentInteractions`, `listMyFollowups`, `KizunaClientError`, `PersonSummary`, `InteractionSummary`, `FollowupSummary`                                                                                                            |
| `@kokoro/bot`       | Telegram + iMessage bot, AI layer, tools, schedulers | App entry point — not imported by other packages                                                                                                                                                                                                                                 |
| `@kokoro/dashboard` | Next.js dashboard (read + write CRUD)                | Overview, conversations, reminders, routines, watchers, confirmations, usage pages                                                                                                                                                                                               |

### Bot-Internal Modules

| Directory                         | Purpose                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/bot/src/ai/`                | LLM integration, prompt assembly, tool orchestration                                                                                                              |
| `apps/bot/src/ai/tools/`          | Tool implementations available to the LLM                                                                                                                         |
| `apps/bot/src/platform/`          | `registry.ts` (AdapterRegistry + platformForChatId helper)                                                                                                        |
| `apps/bot/src/platform/telegram/` | Telegram adapter + bot setup (Grammy long-polling)                                                                                                                |
| `apps/bot/src/platform/imessage/` | BlueBubbles adapter + REST client + webhook server (opt-in, see docs/imessage.md)                                                                                 |
| `apps/bot/src/services/`          | Google OAuth, Gmail, Calendar, Browser, Web search (Brave), Routine executor, Watcher executor, Geocoding, Location, Gated-action dispatcher, Confirmation events |
| `apps/bot/src/scheduler/`         | Proactive, reminder, routine, watcher, maintenance (cleanup + Kioku sweepers)                                                                                     |
| `apps/bot/src/context/`           | Image reference loading + generation                                                                                                                              |
| `apps/bot/src/stt/`               | Speech-to-text (Whisper-compatible API, cloud or local whisper.cpp); see docs/voice.md                                                                            |
| `apps/bot/src/tts/`               | Text-to-speech generation for outbound voice notes                                                                                                                |

## Boot Sequence

1. `validateConfig()` — fail fast on missing LLM/embedding keys
2. Require `TELEGRAM_BOT_TOKEN`
3. Connect to MongoDB
4. Load image context (reference images, settings, image-prefix)
5. Create platform `AdapterRegistry`; create + start Telegram bot (long-polling) and register its adapter
6. If `BLUEBUBBLES_HOST` + `BLUEBUBBLES_PASSWORD` are set: register the iMessage adapter and start the BlueBubbles webhook listener
7. Start proactive scheduler (restore persisted timers from DB)
8. Start reminder scheduler (polls every 60s, fires pending reminders)
9. Start routine scheduler (reset stale locks, polls every 60s, executes due routines)
10. Start watcher scheduler (reset stale locks, archive expired, polls every 60s, runs due detection ticks)
11. Start maintenance scheduler (startup + daily cleanup; startup + 5-min Kioku ingest/fact sweeps)

Graceful shutdown on SIGINT/SIGTERM/uncaughtException/unhandledRejection: stop proactive scheduler, stop reminder scheduler, stop routine scheduler, stop watcher scheduler, stop maintenance scheduler, stop BlueBubbles webhook (if running), shutdown browser, disconnect DB.

## Key Design Decisions

- **Internal packages pattern** — npm workspaces + Turborepo. The `@kokoro/*` library packages (`shared`, `db`, `memory`, `kizuna`) export raw TypeScript source via `exports: { ".": "./src/index.ts" }`; no build step, consumers resolve source directly. Among Kokoro's workspaces only `bot` and `dashboard` have build scripts (esbuild and Next.js respectively) — but the shared `@kagami/logger` and `@kagami/llm` are the exceptions to the raw-source rule: they build to `dist` JS + `.d.ts`, so the externalized (non-`@kokoro/*`) imports resolve to compiled output under plain `node`. The bot's esbuild config (`apps/bot/build.ts`) uses an `externalize-non-kokoro` plugin: every bare import is externalized except `@kokoro/*`, which gets inlined into the single ESM bundle.
- **Session-based conversations** — sessions close after 1 hour of inactivity, replacing daily scoping. Eliminates cross-midnight amnesia.
- **Long-term memory delegated to Kioku** — `@kokoro/memory` is a typed HTTP client; the actual atomic-fact store + hybrid retrieval lives in a separate Kioku service (`KIOKU_URL`, default `https://api.kioku.localhost` via Portless). Use `http://localhost:7777` only when running Kioku standalone outside Portless. See [memory.md](memory.md) for the full subsystem map.
- **Relationship context delegated to Kizuna** — `@kokoro/kizuna` is a GET-only HTTP client for compact CRM projections. It uses `KIZUNA_URL` (default `https://api.kizuna.localhost`) and is gated by `KIZUNA_ENABLED` (default `true`). The bot tools fail open with sanitized degraded results if Kizuna is disabled or unreachable.
- **On-demand retrieval, not eager loading** — the system prompt carries zero facts. The LLM calls `searchMemory` when it needs context. Better retrieval (cosine + BM25 + entity boost) replaces the old tier-and-merge compression strategy.
- **Append-only facts** — atomic facts are write-once. Corrections happen by appending newer facts with later `event_date`; the answerer prompt resolves contradictions newest-wins. No UPDATE / DELETE / soft-archival.
- **Sweepers as correctness layer for Kioku writes** — session-close ingest fires fire-and-forget at four call sites for latency, but a 5-minute sweeper backstops failures: any `closed && ingestStatus: "pending"` conversation gets retried until Kioku confirms. One-off `rememberFact` and learned-place writes use `appendFactWithRetryQueue()`, which queues failed appends in `PendingFact` for the same maintenance tick to retry.
- **Config stays unified** — single config module in `@kokoro/shared`. Base parse always succeeds (defaults for everything). `validateConfig()` must be called explicitly by apps that need LLM/embedding keys (the bot). The dashboard only needs `MONGODB_URI`.
- **Tool-augmented LLM** — the model reads/writes its own memory via `searchMemory` / `rememberFact` tools, not hardcoded logic
- **MongoDB stores deterministic state only** — sessions, reminders, confirmations, routines, watchers, location history. Long-term memory lives in Kioku's vault.
- **GridFS image storage** — user-sent photos stored in MongoDB GridFS (`images` bucket) instead of inline base64
- **Platform abstraction** — `PlatformAdapter` interface enables future platform support
- **Segmented sending** — responses split on `\n\n` for natural pacing
