# Architecture

## System Overview

Kokoro is a layered conversational AI system organized as a monorepo. Messages flow from a platform adapter through normalization, storage, context assembly, LLM generation, and back out as responses.

### Monorepo Layout

```
kokoro/                          # npm workspaces + Turborepo
├── apps/
│   ├── bot/                      # Telegram + iMessage bot app
│   │   ├── src/
│   │   │   ├── ai/               # provider, prompts, response, context-assembler, generate
│   │   │   │   └── tools/        # all tool files (incl. memory.ts — Kioku tool factories)
│   │   │   ├── context/          # image generation (generator.ts, types.ts)
│   │   │   ├── platform/         # registry.ts + telegram/ + imessage/ (multi-adapter)
│   │   │   ├── services/         # google-auth, gmail, google-calendar, browser, cron, routine-executor, watcher-executor, location
│   │   │   └── scheduler/        # proactive (incl. Kioku ingest sweeper), reminders, routines, watchers
│   │   └── context/              # soul (personality), reference images, settings (data)
│   └── dashboard/                # Next.js dashboard (routine + watcher management, observability)
├── packages/
│   ├── typescript-config/        # shared tsconfig bases (JSON only)
│   ├── eslint-config/            # shared ESLint flat config
│   ├── shared/                   # config, logger, markdown, types
│   ├── db/                       # MongoDB connection, models, GridFS
│   └── memory/                   # Kioku HTTP client + transcript glue + sweeper
├── scripts/                      # auth
└── docs/
```

### Dependency Graph

```
@kokoro/typescript-config  ← leaf (no deps)
@kokoro/eslint-config      ← leaf
       ↑
@kokoro/shared  ← config, logger, markdown, types (dotenv, zod, pino, gray-matter)
       ↑
@kokoro/db      ← MongoDB connection, models, GridFS (mongoose)
       ↑
@kokoro/memory  ← Kioku HTTP client + conversation→transcript glue + session-close ingest
       ↑
@kokoro/bot     ← AI layer, tools, platform, schedulers
@kokoro/dashboard ← Next.js (routine + watcher management, observability)
```

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
│  │ photo/email/  │  └──────────────┘                 │
│  │ cal/reminders │                                    │
│  │ browse/web    │                                    │
│  │ routines      │                                    │
│  │ watchers      │                                    │
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
│Confirm   │                  http://localhost:7777)
└──────────┘

┌──────────────────────────┐
│   Proactive Scheduler    │    ← apps/bot/src/scheduler/
│                          │
│ timers ─► idle check     │
│        ─► active hours   │
│        ─► generate msg   │
│        ─► persist state  │
│        ─► daily cleanup  │
│        ─► Kioku sweeper  │
│           (5 min tick)   │
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
│  ─► outfit/setting pick  │
│  ─► xAI Grok Imagine     │
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
       │   ├─ System: soul.md + datetime + tool guidance + reminders + location
       │   │         (no facts pre-loaded — Mashiro calls searchMemory on demand)
       │   └─ Messages: last 40 msgs from active session, images from GridFS,
       │                tool-call pairs (recent 10 only)
       │
10. generateText({ model, system, messages, tools, stopWhen: stepCountIs(5), temperature: 0.7 })
       │   └─ LLM may call tools (searchMemory, rememberFact, sendPhoto, sendEmail, etc.)
       │       searchMemory → @kokoro/memory.recall() → POST Kioku /recall
       │       rememberFact → @kokoro/memory.appendFact() → POST Kioku /facts
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

See [memory.md](memory.md) for the Kioku read/write paths in full, including the sweeper that backstops fire-and-forget ingest failures.

## Proactive Scheduler

The scheduler sends unprompted messages to maintain engagement:

- **Active hours**: 9:00 AM – 1:00 AM (outside → reschedule to next 9 AM)
- **Idle requirement**: user must be idle >= 1 hour before firing
- **Intervals**: 1.5–2.5 hours between proactive messages
- **Startup**: 30–60 minute delay after boot
- **Persistence**: next-fire timestamps saved to MongoDB (survives restarts)
- **Reset**: any user message reschedules the next proactive to 1.5–2.5h out
- **Kioku ingest sweeper**: every 5 minutes, drives any `closed && ingestStatus: "pending"` conversations to `done` (retrying through Kioku outages) and closes `active` sessions idle past 6h so they become eligible for ingest. See [memory.md](memory.md).
- **Daily cleanup**: removes fired reminders (>30 days), closed conversations (>90 days), old routine logs (>90 days), and old location history (>90 days)

When firing, the scheduler uses `getOrCreateSession` to get the active session, assembles a proactive system prompt with sessionId, and injects a synthetic nudge if no recent user message exists.

## Package Boundaries

| Package             | Purpose                                              | Key Exports                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kokoro/shared`    | Config, logging, markdown, platform types            | `config`, `logger`, `parseMarkdown`, `toMarkdown`, `IncomingMessage`, `PlatformAdapter`, cron + routine validation helpers                                                                                    |
| `@kokoro/db`        | MongoDB connection, all models, GridFS               | `connectDB`, `disconnectDB`, `Conversation`, `Reminder`, `SchedulerState`, `Routine`, `RoutineLog`, `LocationHistory`, `PendingConfirmation`, `readImage`, `writeImage`, all model CRUD functions             |
| `@kokoro/memory`    | Kioku HTTP client + conversation→transcript glue     | `recall`, `appendFact`, `getFactById`, `getFactCount`, `hasFactsForSession`, `ingestSession`, `buildTranscript`, `ingestClosedSession`, `sweepPendingIngests`, `sweepStaleActiveSessions`, `KiokuClientError` |
| `@kokoro/bot`       | Telegram + iMessage bot, AI layer, tools, schedulers | App entry point — not imported by other packages                                                                                                                                                              |
| `@kokoro/dashboard` | Next.js dashboard (read + write CRUD)                | Overview, conversations, reminders, routines, watchers, usage pages                                                                                                                                           |

### Bot-Internal Modules

| Directory                         | Purpose                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/bot/src/ai/`                | LLM integration, prompt assembly, tool orchestration                                                         |
| `apps/bot/src/ai/tools/`          | Tool implementations available to the LLM                                                                    |
| `apps/bot/src/platform/`          | `registry.ts` (AdapterRegistry + platformForChatId helper)                                                   |
| `apps/bot/src/platform/telegram/` | Telegram adapter + bot setup (Grammy long-polling)                                                           |
| `apps/bot/src/platform/imessage/` | BlueBubbles adapter + REST client + webhook server (opt-in, see docs/imessage.md)                            |
| `apps/bot/src/services/`          | Google OAuth, Gmail, Calendar, Browser, Cron, Routine executor, Geocoding, Location, Gated-action dispatcher |
| `apps/bot/src/scheduler/`         | Proactive, reminder, routine scheduling                                                                      |
| `apps/bot/src/context/`           | Image reference loading + generation                                                                         |
| `apps/bot/src/stt/`               | Speech-to-text (Whisper-compatible API, cloud or local whisper.cpp); see docs/voice.md                       |

## Boot Sequence

1. Validate TELEGRAM_BOT_TOKEN
2. Connect to MongoDB
3. Load image context (reference images + setting descriptions)
4. Create Telegram bot with handlers (allowlist → rate limit → message handlers)
5. Start bot (long-polling)
6. Start proactive scheduler (restore timers from DB, start daily cleanup)
7. Start reminder scheduler (polls every 60s, fires pending reminders)
8. Start routine scheduler (reset stale locks, polls every 60s, executes due routines)
9. Start watcher scheduler (reset stale locks, archive expired, polls every 60s, runs due detection ticks)

Graceful shutdown on SIGINT/SIGTERM/uncaughtException/unhandledRejection: stop proactive scheduler, stop reminder scheduler, stop routine scheduler, stop watcher scheduler, shutdown browser, disconnect DB.

## Key Design Decisions

- **Internal packages pattern** — npm workspaces + Turborepo. Library packages (`shared`, `db`, `memory`) export raw TypeScript source via `exports: { ".": "./src/index.ts" }`. No build step for libraries; consumers resolve source directly. Only `bot` and `dashboard` have build scripts (tsup and Next.js respectively). The bot's tsup config uses `noExternal: [/^@kokoro\//]` to inline all workspace packages into a single bundle.
- **Session-based conversations** — sessions close after 1 hour of inactivity, replacing daily scoping. Eliminates cross-midnight amnesia.
- **Long-term memory delegated to Kioku** — `@kokoro/memory` is a typed HTTP client; the actual atomic-fact store + hybrid retrieval lives in a separate Kioku service (`KIOKU_URL`, default `http://localhost:7777`). See [memory.md](memory.md) for the full subsystem map.
- **On-demand retrieval, not eager loading** — the system prompt carries zero facts. The LLM calls `searchMemory` when it needs context. Better retrieval (cosine + BM25 + entity boost) replaces the old tier-and-merge compression strategy.
- **Append-only facts** — atomic facts are write-once. Corrections happen by appending newer facts with later `event_date`; the answerer prompt resolves contradictions newest-wins. No UPDATE / DELETE / soft-archival.
- **Sweeper as correctness layer for ingest** — session-close ingest fires fire-and-forget at four call sites for latency, but a 5-minute sweeper backstops failures: any `closed && ingestStatus: "pending"` conversation gets retried until Kioku confirms.
- **Config stays unified** — single config module in `@kokoro/shared`. Base parse always succeeds (defaults for everything). `validateConfig()` must be called explicitly by apps that need LLM/embedding keys (the bot). The dashboard only needs `MONGODB_URI`.
- **Tool-augmented LLM** — the model reads/writes its own memory via `searchMemory` / `rememberFact` tools, not hardcoded logic
- **MongoDB stores deterministic state only** — sessions, reminders, confirmations, routines, watchers, location history. Long-term memory lives in Kioku's vault.
- **GridFS image storage** — user-sent photos stored in MongoDB GridFS (`images` bucket) instead of inline base64
- **Platform abstraction** — `PlatformAdapter` interface enables future platform support
- **Segmented sending** — responses split on `\n\n` for natural pacing
