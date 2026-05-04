# CLAUDE.md

## Project

Kokoro — a Telegram-based conversational AI that maintains persistent personality, memories, and proactive engagement. Built as a monorepo with TypeScript, Vercel AI SDK, MongoDB, and the Grammy Telegram framework. Includes a Next.js dashboard for routine management and observability.

## Monorepo Structure

```
kokoro/
├── apps/
│   ├── bot/          # Telegram bot (Grammy, AI tools, schedulers)
│   │   └── context/  # soul.md (personality), reference images, settings
│   └── dashboard/    # Next.js dashboard (routine management, observability, auth)
├── packages/
│   ├── typescript-config/  # Shared tsconfig bases (JSON only)
│   ├── eslint-config/      # Shared ESLint flat config
│   ├── shared/             # config, logger, markdown, types
│   ├── db/                 # MongoDB connection, models, GridFS
│   └── test-utils/         # Vitest harness (withTestDb, mockLLM, fakeAdapter, MSW)
├── scripts/          # Auth scripts
└── docs/
```

**Stack**: npm workspaces + Turborepo (internal packages pattern — libraries export raw `.ts` source, only apps build)

## Commands

```bash
npm run build        # turbo run build (all packages + apps)
npm run dev          # turbo run dev (starts bot with tsx watch)
npm run typecheck    # turbo run typecheck (all packages)
npm run test         # vitest run (all projects, ~10s)
npm run test:watch   # vitest watch mode
npm run test:coverage # V8 coverage; HTML report at coverage/index.html
npm run lint         # turbo run lint (all packages)
npm run lint:fix     # turbo run lint:fix
npm run format       # prettier --write all files
npm run auth:google  # Google OAuth setup
```

The dashboard dev server runs under [Portless](https://github.com/vercel-labs/portless) at `https://kokoro.localhost` (HTTPS auto-trusted, port assigned dynamically). First run prompts once for sudo to install the local CA.

## Dependency Graph

```
@kokoro/typescript-config  ← leaf
@kokoro/eslint-config      ← leaf
       ↑
@kokoro/shared  ← config, logger, markdown, types
       ↑
@kokoro/db      ← mongoose, models, GridFS
       ↑
@kokoro/memory  ← Kioku client + conversation→transcript glue + session-close ingest
       ↑
@kokoro/bot     ← AI layer, tools, platform adapter, schedulers
@kokoro/dashboard ← Next.js (routine management, observability)
```

## Conventions

- **TypeScript + ESM** — strict mode, ES2022 target, ESNext modules, `verbatimModuleSyntax`
- **Async everywhere** — all I/O is async/await, no callbacks
- **Zod for config** — environment variables validated at startup via `@kokoro/shared` config
- **Pino logging** — structured logs, use `logger.info({ context }, "message")` pattern
- **Vercel AI SDK** — `generateText()` from `ai` package for all LLM calls
- **No classes for services** — prefer standalone exported functions
- **Platform-agnostic types** — `IncomingMessage`/`PlatformAdapter` in `@kokoro/shared`
- **Cross-package imports** — use `@kokoro/shared`, `@kokoro/db`, `@kokoro/memory` (not relative paths)
- **Within-package imports** — use relative paths without file extensions
- **Internal packages** — libraries export raw `.ts` source (`exports: "./src/index.ts"`); only `bot` and `dashboard` have build steps
- **`.env` location** — `apps/bot/.env` (not root)
- **Tests as source of truth** — when a test fails because production behaves differently than the test expects, fix the bot, not the test. See `docs/testing.md` for the harness and coverage map.

## Doc Maintenance

After any code change, update the relevant doc in `/docs` to reflect the change. If a new module or major feature is added, create a new doc file. Keep docs accurate — they are the primary architecture reference.

See `/docs` for:

- [architecture.md](docs/architecture.md) — system overview, message flow, module map
- [telegram.md](docs/telegram.md) — platform adapter, bot handlers, rate limiting
- [ai-layer.md](docs/ai-layer.md) — LLM integration, tools, image generation, context assembly
- [memory.md](docs/memory.md) — Kioku integration: read/write paths, session-close ingest, sweeper, conversation lifecycle
- [watchers.md](docs/watchers.md) — scheduled detection jobs (read-only, stateful, trigger-only notifications)
- [confirmations.md](docs/confirmations.md) — approval primitive for gated tool calls (tap-to-approve actions)
- [imessage.md](docs/imessage.md) — iMessage adapter via BlueBubbles (multi-platform setup, webhook, YES/NO confirmation UX)
- [voice.md](docs/voice.md) — speech-to-text for inbound voice notes (local whisper.cpp default, cloud fallback)
- [testing.md](docs/testing.md) — test harness, mocking strategy, per-module coverage map
