# CLAUDE.md

## Project

AIGF (AI Girlfriend Framework) — a Telegram-based conversational AI that maintains persistent personality, memories, and proactive engagement. Built with TypeScript, Vercel AI SDK, MongoDB, and the Grammy Telegram framework.

## Commands

```bash
npm run dev          # Start dev server (tsx watch)
npm run build        # Production build (tsup)
npm run start        # Run compiled app
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm run lint:fix     # eslint src/ --fix
npm run format       # prettier --write src/
npm run seed:vault   # Initialize vault directory
```

## Conventions

- **TypeScript + ESM** — strict mode, ES2022 target, ESNext modules
- **Async everywhere** — all I/O is async/await, no callbacks
- **Zod for config** — environment variables validated at startup via `src/config.ts`
- **Pino logging** — structured logs, use `logger.info({ context }, "message")` pattern
- **Vercel AI SDK** — `generateText()` from `ai` package for all LLM calls
- **No classes for services** — prefer standalone exported functions
- **Platform-agnostic types** — `IncomingMessage`/`OutgoingMessage` in `src/platform/types.ts`; adapters implement `PlatformAdapter`

## Doc Maintenance

After any code change, update the relevant doc in `/docs` to reflect the change. If a new module or major feature is added, create a new doc file. Keep docs accurate — they are the primary architecture reference.

See `/docs` for:
- [architecture.md](docs/architecture.md) — system overview, message flow, module map
- [vault.md](docs/vault.md) — memory system, curation pipeline, frontmatter schema
- [telegram.md](docs/telegram.md) — platform adapter, bot handlers, rate limiting
- [ai-layer.md](docs/ai-layer.md) — LLM integration, tools, image generation, context assembly
