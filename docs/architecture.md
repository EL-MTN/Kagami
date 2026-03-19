# Architecture

## System Overview

Mashiro is a layered conversational AI system organized as a monorepo. Messages flow from a platform adapter through normalization, storage, context assembly, LLM generation, and back out as responses.

### Monorepo Layout

```
mashiro/                          # npm workspaces + Turborepo
├── apps/
│   ├── bot/                      # Telegram bot app
│   │   ├── src/
│   │   │   ├── ai/               # provider, prompts, response, context-assembler, generate
│   │   │   │   └── tools/        # all tool files
│   │   │   ├── context/          # image generation (generator.ts, types.ts)
│   │   │   ├── memory/           # curator.ts (tightly coupled to AI layer)
│   │   │   ├── platform/telegram/
│   │   │   ├── services/         # google-auth, gmail, google-calendar, browser, cron, skill-executor
│   │   │   └── scheduler/        # proactive, reminders, skills
│   │   ├── vault/                # personality card (data)
│   │   └── context/              # reference images/settings (data)
│   └── dashboard/                # Next.js dashboard (skill management, observability)
├── packages/
│   ├── typescript-config/        # shared tsconfig bases (JSON only)
│   ├── eslint-config/            # shared ESLint flat config
│   ├── shared/                   # config, logger, markdown, types
│   ├── db/                       # MongoDB connection, models, GridFS
│   └── memory/                   # engine, embedding, vault
├── scripts/                      # migrate, seed, auth
└── docs/
```

### Dependency Graph

```
@mashiro/typescript-config  ← leaf (no deps)
@mashiro/eslint-config      ← leaf
       ↑
@mashiro/shared  ← config, logger, markdown, types (dotenv, zod, pino, gray-matter)
       ↑
@mashiro/db      ← MongoDB connection, models, GridFS (mongoose)
       ↑
@mashiro/memory  ← engine, embedding, vault (@ai-sdk/google, ai)
       ↑
@mashiro/bot     ← AI layer, tools, platform, schedulers
@mashiro/dashboard ← Next.js (placeholder)
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                    Telegram Bot                      │
│          (Grammy / apps/bot/src/platform/)           │
│         allowlist ─► rate limit ─► handlers          │
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
│  │ remember-fact/│  │  (system +   │                 │
│  │ note-to-self/ │  │   format)    │                 │
│  │ read/search/  │  └──────────────┘                 │
│  │ list/curate/  │                                    │
│  │ photo/email/  │                                    │
│  │ cal/reminders/│                                    │
│  │ browse/       │                                    │
│  │ skills        │                                    │
│  └──────┬───────┘                                    │
└─────────┼────────────────────────────────────────────┘
          │
    ┌─────┴──────┐
    ▼            ▼
┌────────┐  ┌────────────┐
│ Memory │  │  Database   │
│ Vault  │  │  (MongoDB)  │    ← packages/memory + packages/db
│ (.md)  │  │             │
│        │  │ Conversation│
│ person │  │ Scheduler   │
│ ality/ │  │ State       │
│ card   │  │ Memory      │
│        │  │ Reminder    │
│        │  │ Skill       │
│        │  │ SkillLog    │
│        │  │ TokenUsage  │
│        │  │ Location    │
│        │  │  History    │
└────────┘  └─────────────┘
    ▲            ▲
    └─────┬──────┘
          │
┌─────────────────────────┐
│    Memory Engine         │    ← packages/memory
│                          │
│ embedding (Google Gemini)│
│  ─► cosine similarity    │
│  ─► remember / recall    │
│  ─► fact ADD/UPDATE/DEL  │
│  ─► working memory (TTL) │
│  ─► soft archival        │
└──────────────────────────┘

┌──────────────────────────┐
│   Proactive Scheduler    │    ← apps/bot/src/scheduler/
│                          │
│ timers ─► idle check     │
│        ─► active hours   │
│        ─► generate msg   │
│        ─► persist state  │
│        ─► weekly/monthly │
│        ─► daily cleanup  │
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
│   Skill Scheduler        │    ← apps/bot/src/scheduler/skills.ts
│                          │
│ poll 60s ─► due?         │
│           ─► execute     │
│           ─► log result  │
│           ─► advance cron│
│ startup recovery         │
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
1. User sends message on Telegram
       │
2. Grammy handler fires (message:text, message:photo, or message:location)
       │
3. Allowlist check ─► Rate limit check
       │
4. adapter.normalize(ctx) → IncomingMessage
       │  (for photos: download file, convert to base64)
       │
5. getOrCreateSession(chatId) — idle-based (1h threshold)
       │  ├─ If stale session found: close it, queue background curation
       │  └─ Return active session with sessionId
       │
6. If image: write to GridFS → get imageRef key
       │
7. appendMessage(conversation, userMsg with imageRef)
       │
8. curateIfNeeded(chatId) — fire-and-forget (non-blocking):
       │   ├─ Per-chat mutex prevents concurrent curation
       │   ├─ summarize overflow → Memory collection episode (MongoDB only)
       │   ├─ extract structured metadata (emotionalTone, importance, followUps)
       │   ├─ classify facts as ADD/UPDATE/DELETE (bounded: 30 most relevant facts)
       │   └─ trim conversation to 40 messages (delete orphaned GridFS images)
       │
9. Parallel: assembleSystemPrompt(chatId, sessionId) + assembleMessages(chatId)
       │   ├─ System: personality + facts (top 30) + milestones (last 5)
       │   │         + daily episodes (3) + weekly episodes (2)
       │   │         + working memory + follow-ups + location + datetime + tools + format
       │   └─ Messages: last 40 msgs from active session, images from GridFS, tool-call pairs (recent 10 only)
       │
10. generateText({ model, system, messages, tools, stopWhen: stepCountIs(5), temperature: 0.7 })
       │   └─ LLM may call tools (rememberFact, noteToSelf, readMemory, searchMemory, sendPhoto, etc.)
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

## Proactive Scheduler

The scheduler sends unprompted messages to maintain engagement:

- **Active hours**: 9:00 AM – 1:00 AM (outside → reschedule to next 9 AM)
- **Idle requirement**: user must be idle >= 1 hour before firing
- **Intervals**: 1.5–2.5 hours between proactive messages
- **Startup**: 30–60 minute delay after boot
- **Persistence**: next-fire timestamps saved to MongoDB (survives restarts)
- **Reset**: any user message reschedules the next proactive to 1.5–2.5h out
- **Memory consolidation**: after each proactive fire, checks weekly merge and monthly consolidation (fire-and-forget)
- **Daily cleanup**: removes fired reminders (>30 days), closed conversations (>90 days), old skill logs (>90 days), and old location history (>90 days)

When firing, the scheduler uses `getOrCreateSession` to get the active session, assembles a proactive system prompt with sessionId, and injects a synthetic nudge if no recent user message exists.

## Package Boundaries

| Package              | Purpose                                            | Key Exports                                                                                                                                                                      |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mashiro/shared`    | Config, logging, markdown, platform types          | `config`, `logger`, `parseMarkdown`, `toMarkdown`, `IncomingMessage`, `PlatformAdapter`, `VaultFile`                                                                             |
| `@mashiro/db`        | MongoDB connection, all models, GridFS             | `connectDB`, `disconnectDB`, `Memory`, `Conversation`, `Reminder`, `SchedulerState`, `Skill`, `SkillLog`, `LocationHistory`, `readImage`, `writeImage`, all model CRUD functions |
| `@mashiro/memory`    | Memory engine, embeddings, vault files             | `remember`, `recall`, `forget`, `readVaultFile`, `writeVaultFile`, `generateEmbedding`, episode/fact/milestone retrieval                                                         |
| `@mashiro/bot`       | Telegram bot, AI layer, tools, schedulers, curator | App entry point — not imported by other packages                                                                                                                                 |
| `@mashiro/dashboard` | Next.js dashboard (read-only data viewer)          | Overview, conversations, memories, reminders, skills pages                                                                                                                       |

### Bot-Internal Modules

| Directory                         | Purpose                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `apps/bot/src/ai/`                | LLM integration, prompt assembly, tool orchestration                              |
| `apps/bot/src/ai/tools/`          | Tool implementations available to the LLM                                         |
| `apps/bot/src/platform/telegram/` | Telegram adapter + bot setup                                                      |
| `apps/bot/src/memory/`            | Curator (tightly coupled to AI layer)                                             |
| `apps/bot/src/services/`          | Google OAuth, Gmail, Calendar, Browser, Cron, Skill executor, Geocoding, Location |
| `apps/bot/src/scheduler/`         | Proactive, reminder, skill scheduling                                             |
| `apps/bot/src/context/`           | Image reference loading + generation                                              |

## Boot Sequence

1. Validate TELEGRAM_BOT_TOKEN
2. Connect to MongoDB
3. Load image context (reference images + setting descriptions)
4. Create Telegram bot with handlers (allowlist → rate limit → message handlers)
5. Start bot (long-polling)
6. Start proactive scheduler (restore timers from DB, start daily cleanup)
7. Start reminder scheduler (polls every 60s, fires pending reminders)
8. Start skill scheduler (reset stale locks, polls every 60s, executes due skills)

Graceful shutdown on SIGINT/SIGTERM/uncaughtException/unhandledRejection: stop proactive scheduler, stop reminder scheduler, stop skill scheduler, shutdown browser, disconnect DB.

## Key Design Decisions

- **Internal packages pattern** — npm workspaces + Turborepo. Library packages (`shared`, `db`, `memory`) export raw TypeScript source via `exports: { ".": "./src/index.ts" }`. No build step for libraries; consumers resolve source directly. Only `bot` and `dashboard` have build scripts (tsup and Next.js respectively). The bot's tsup config uses `noExternal: [/^@mashiro\//]` to inline all workspace packages into a single bundle.
- **Session-based conversations** — sessions close after 1 hour of inactivity, replacing daily scoping. Eliminates cross-midnight amnesia.
- **Curator stays in bot** — `curator.ts` imports `getModel` and `generateObject` from the AI layer. Dashboard only reads data, never curates.
- **Config stays unified** — single config module in `@mashiro/shared`. Base parse always succeeds (defaults for everything). `validateConfig()` must be called explicitly by apps that need LLM/embedding keys (the bot). The dashboard only needs `MONGODB_URI`.
- **Dashboard is read-only** — imports `@mashiro/db` models directly, never `@mashiro/memory` (avoids Google AI SDK dependency). All pages are React Server Components.
- **Non-blocking curation** — curation runs as fire-and-forget with per-chat mutex, so users don't wait for LLM calls
- **40-message context window** — overflow is summarized into MongoDB episodes, not lost
- **Separated episode types** — daily episodes, weekly merges, and monthly consolidations are queried separately to prevent conflation
- **Bounded fact retrieval** — only 30 most relevant facts sent to LLM for classification, not the entire collection
- **Non-destructive merges** — weekly/monthly merges soft-archive originals instead of deleting them
- **Working memory** — session-scoped temporary notes with 24h TTL, auto-cleaned by MongoDB
- **Tool-augmented LLM** — the model reads/writes its own memory via tools, not hardcoded logic
- **MongoDB as single source of truth** — vault reserved only for the hand-edited personality card
- **GridFS image storage** — user-sent photos stored in MongoDB GridFS (`images` bucket) instead of inline base64
- **Semantic memory** — Google Gemini embeddings + cosine similarity for meaning-based retrieval with 200-candidate cap
- **Smart fact management** — ADD/UPDATE/DELETE operations prevent stale fact accumulation
- **Platform abstraction** — `PlatformAdapter` interface enables future platform support
- **Segmented sending** — responses split on `\n\n` for natural pacing
