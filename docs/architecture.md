# Architecture

## System Overview

Mashiro is a layered conversational AI system. Messages flow from a platform adapter through normalization, storage, context assembly, LLM generation, and back out as responses.

```
┌─────────────────────────────────────────────────────┐
│                    Telegram Bot                      │
│              (Grammy / bot.ts)                        │
│         allowlist ─► rate limit ─► handlers          │
└──────────────┬──────────────────────┬────────────────┘
               │ IncomingMessage      │ sendText/sendPhoto
               ▼                      ▲
┌──────────────────────────────────────────────────────┐
│                   AI Layer                            │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │   generate    │  │   context    │  │  response   │ │
│  │  (handler)    │──│  assembler   │  │  utilities  │ │
│  └──────┬───────┘  └──────┬───────┘  └────────────┘ │
│         │                 │                          │
│  ┌──────┴───────┐  ┌──────┴───────┐                 │
│  │    tools/     │  │   prompts    │                 │
│  │ read/write/   │  │  (system +   │                 │
│  │ search/list/  │  │   format)    │                 │
│  │ curate/photo/ │  └──────────────┘                 │
│  │ email/cal/    │                                    │
│  │ reminders     │                                    │
│  └──────┬───────┘                                    │
└─────────┼────────────────────────────────────────────┘
          │
    ┌─────┴──────┐
    ▼            ▼
┌────────┐  ┌────────────┐
│ Memory │  │  Database   │
│ Vault  │  │  (MongoDB)  │
│ (.md)  │  │             │
│        │  │ Conversation│
│ person │  │ Scheduler   │
│ ality/ │  │ State       │
│ memori │  │ Memory      │
│ es/    │  │ Reminder    │
│        │  └─────────────┘
└────────┘
    ▲            ▲
    └─────┬──────┘
          │
┌─────────────────────────┐
│    Memory Engine         │
│                          │
│ embedding (Google Gemini)│
│  ─► cosine similarity    │
│  ─► remember / recall    │
│  ─► fact ADD/UPDATE/DEL  │
└──────────────────────────┘

┌──────────────────────────┐
│   Proactive Scheduler    │
│                          │
│ timers ─► idle check     │
│        ─► active hours   │
│        ─► generate msg   │
│        ─► persist state  │
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
│   Google Services        │
│                          │
│ OAuth2 singleton         │
│  ─► Gmail (read-only)    │
│  ─► Calendar (CRUD)      │
│  (conditional on config) │
└──────────────────────────┘

┌──────────────────────────┐
│   Image Generation       │
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
2. Grammy handler fires (message:text or message:photo)
       │
3. Allowlist check ─► Rate limit check
       │
4. adapter.normalize(ctx) → IncomingMessage
       │  (for photos: download file, convert to base64)
       │
5. getOrCreateConversation(chatId) — daily scoped
       │
6. If image: write to GridFS → get imageRef key
       │
7. appendMessage(conversation, userMsg with imageRef)
       │
8. curateIfNeeded(chatId) — if overflow >= 40 messages (batch curation):
       │   ├─ summarize overflow → Memory collection episode (MongoDB only)
       │   ├─ extract structured metadata (emotionalTone, importance, followUps)
       │   ├─ classify facts as ADD/UPDATE/DELETE via LLM → Memory collection
       │   ├─ regenerate about-you.md from all current facts
       │   ├─ trim conversation to 40 messages (delete orphaned GridFS images)
       │   ├─ check weekly merge (4+ old episodes → weekly-merge episode)
       │   └─ check monthly consolidation (3+ old weekly episodes → milestone)
       │
9. Parallel: assembleSystemPrompt() + assembleMessages(chatId)
       │   ├─ System: personality + user facts + milestones + recent episodes + follow-ups + datetime + tools + format
       │   └─ Messages: last 40 msgs, images loaded from GridFS on demand, tool-call pairs reconstructed
       │
10. generateText({ model, system, messages, tools, maxSteps: 5, temperature: 0.7 })
       │   └─ LLM may call tools (readMemory, writeMemory, searchMemory, sendPhoto, etc.)
       │
11. extractResponseText(steps) + collectToolCalls(steps)
       │
12. appendMessage(conversation, assistantMsg with toolCalls)
       │
13. sendSegmented(adapter, chatId, text) — split on \n\n, typing delays
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

When firing, the scheduler assembles a proactive system prompt (personality + proactive instructions) and injects a synthetic nudge if no recent user message exists.

## Module Boundaries

| Directory | Purpose | Key Files |
|---|---|---|
| `src/ai/` | LLM integration, prompt assembly, tool orchestration | `generate.ts`, `context-assembler.ts`, `prompts.ts`, `provider.ts`, `response.ts` |
| `src/ai/tools/` | Tool implementations available to the LLM | `index.ts`, `read-memory.ts`, `write-memory.ts`, `search-memory.ts`, `list-memories.ts`, `curate-memory.ts`, `send-photo.ts`, `check-email.ts`, `manage-calendar.ts`, `manage-reminders.ts` |
| `src/platform/` | Platform-agnostic message types | `types.ts` |
| `src/platform/telegram/` | Telegram adapter + bot setup | `adapter.ts`, `bot.ts` |
| `src/memory/` | Vault file operations, curation pipeline, Memory Engine | `vault.ts`, `curator.ts`, `engine.ts`, `embedding.ts`, `types.ts` |
| `src/db/` | MongoDB connection, data models, GridFS image store | `connection.ts`, `gridfs.ts`, `models/conversation.ts`, `models/scheduler-state.ts`, `models/memory.ts` |
| `src/services/` | External service integrations (Google OAuth, Gmail, Calendar) | `google-auth.ts`, `gmail.ts`, `google-calendar.ts` |
| `src/scheduler/` | Proactive message & reminder scheduling | `proactive.ts`, `reminders.ts` |
| `src/context/` | Image reference loading + generation | `generator.ts`, `types.ts` |
| `src/utils/` | Logger, markdown/frontmatter parsing | `logger.ts`, `markdown.ts` |
| `src/config.ts` | Zod-validated environment config | — |
| `src/index.ts` | App entry point, boot sequence | — |
| `vault/` | User-editable memory files (personality, facts, milestones) | `personality/card.md`, `memories/about-you.md`, `memories/milestones.md` |
| `context/` | Image generation assets (references, settings) | `references/face/`, `references/body/`, `references/outfits/`, `settings/` |

## Boot Sequence

1. Connect to MongoDB
2. Load image context (reference images + setting descriptions)
3. Create Telegram bot with handlers (allowlist → rate limit → message handlers)
4. Start bot (long-polling)
5. Start proactive scheduler (restore timers from DB)
6. Start reminder scheduler (polls every 60s, fires pending reminders)

Graceful shutdown on SIGINT/SIGTERM/uncaughtException/unhandledRejection: stop proactive scheduler, stop reminder scheduler, disconnect DB.

## Key Design Decisions

- **Daily conversation scoping** — conversations reset at midnight, keeping context fresh
- **40-message context window** — overflow is summarized into MongoDB episodes, not lost
- **Tool-augmented LLM** — the model reads/writes its own memory via tools, not hardcoded logic
- **MongoDB as single source of truth** — conversations stored exclusively in Memory collection; vault files reserved for static content (personality, facts, milestones)
- **GridFS image storage** — user-sent photos stored in MongoDB GridFS (`images` bucket) instead of inline base64, keeping conversation documents lean and avoiding the 16MB BSON limit
- **Semantic memory** — Google Gemini embeddings + cosine similarity for meaning-based retrieval
- **Smart fact management** — ADD/UPDATE/DELETE operations prevent stale fact accumulation
- **Platform abstraction** — `PlatformAdapter` interface enables future platform support
- **Segmented sending** — responses split on `\n\n` with typing delays for natural pacing
