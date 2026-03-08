# CLAUDE.md

## Project

Mashiro — a Telegram-based conversational AI that maintains persistent personality, memories, and proactive engagement. Built as a monorepo with TypeScript, Vercel AI SDK, MongoDB, and the Grammy Telegram framework. Includes a Next.js dashboard (placeholder).

## Monorepo Structure

```
mashiro/
├── apps/
│   ├── bot/          # Telegram bot (Grammy, AI tools, schedulers)
│   └── dashboard/    # Next.js dashboard (placeholder)
├── packages/
│   ├── typescript-config/  # Shared tsconfig bases (JSON only)
│   ├── eslint-config/      # Shared ESLint flat config
│   ├── shared/             # config, logger, markdown, types
│   ├── db/                 # MongoDB connection, models, GridFS
│   └── memory/             # engine, embedding, vault
├── scripts/          # Migration, seed, auth scripts
├── vault/            # Persistent memory store (data)
├── context/          # Character reference images/settings
└── docs/
```

**Stack**: npm workspaces + Turborepo (internal packages pattern — libraries export raw `.ts` source, only apps build)

## Commands

```bash
npm run build        # turbo run build (all packages + apps)
npm run dev          # turbo run dev (starts bot with tsx watch)
npm run typecheck    # turbo run typecheck (all packages)
npm run lint         # turbo run lint (all packages)
npm run lint:fix     # turbo run lint:fix
npm run format       # prettier --write all files
npm run seed:vault   # Initialize vault directory
npm run auth:google  # Google OAuth setup
npm run migrate:memory # Memory system migration
```

## Dependency Graph

```
@mashiro/typescript-config  ← leaf
@mashiro/eslint-config      ← leaf
       ↑
@mashiro/shared  ← config, logger, markdown, types
       ↑
@mashiro/db      ← mongoose, models, GridFS
       ↑
@mashiro/memory  ← engine, embedding, vault
       ↑
@mashiro/bot     ← AI layer, tools, platform adapter, schedulers
@mashiro/dashboard ← Next.js (placeholder)
```

## Conventions

- **TypeScript + ESM** — strict mode, ES2022 target, ESNext modules, `verbatimModuleSyntax`
- **Async everywhere** — all I/O is async/await, no callbacks
- **Zod for config** — environment variables validated at startup via `@mashiro/shared` config
- **Pino logging** — structured logs, use `logger.info({ context }, "message")` pattern
- **Vercel AI SDK** — `generateText()` from `ai` package for all LLM calls
- **No classes for services** — prefer standalone exported functions
- **Platform-agnostic types** — `IncomingMessage`/`PlatformAdapter` in `@mashiro/shared`
- **Cross-package imports** — use `@mashiro/shared`, `@mashiro/db`, `@mashiro/memory` (not relative paths)
- **Within-package imports** — use relative paths with `.js` extension
- **Internal packages** — libraries export raw `.ts` source (`exports: "./src/index.ts"`); only `bot` and `dashboard` have build steps
- **`.env` location** — `apps/bot/.env` (not root)

## Doc Maintenance

After any code change, update the relevant doc in `/docs` to reflect the change. If a new module or major feature is added, create a new doc file. Keep docs accurate — they are the primary architecture reference.

See `/docs` for:
- [architecture.md](docs/architecture.md) — system overview, message flow, module map
- [vault.md](docs/vault.md) — memory system, curation pipeline, frontmatter schema
- [telegram.md](docs/telegram.md) — platform adapter, bot handlers, rate limiting
- [ai-layer.md](docs/ai-layer.md) — LLM integration, tools, image generation, context assembly
- [memory-management.md](docs/memory-management.md) — deep dive into memory tiers, data flow, gaps, and roadmap
