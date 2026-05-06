# CLAUDE.md

## Project

Kokoro — a Telegram-based conversational AI that maintains persistent personality, memories, and proactive engagement. Built as a monorepo with TypeScript, Vercel AI SDK, MongoDB, and the Grammy Telegram framework. Includes a Next.js dashboard for routine management and observability.

Kokoro is now a subtree inside the **Kagami nested monorepo** (`/Kagami/kokoro/`). It consumes shared tooling — `@kagami/eslint-config` and `@kagami/tsconfig` — from `Kagami/shared/packages/`. There is no top-level `package.json`, `turbo.json`, or `package-lock.json` inside `kokoro/`; those live at the Kagami root. Husky hooks are also managed at the Kagami root (no `kokoro/.husky/`).

## Monorepo Structure

```
kokoro/
├── apps/
│   ├── bot/          # Telegram bot (Grammy, AI tools, schedulers)
│   │   └── context/  # soul.md (personality), reference images, settings
│   └── dashboard/    # Next.js dashboard (routine management, observability, auth)
├── packages/
│   ├── shared/       # config, logger, markdown, types
│   ├── db/           # MongoDB connection, models, GridFS
│   ├── memory/       # Kioku HTTP client + transcript glue + sweeper
│   └── test-utils/   # Vitest harness (withTestDb, fakeAdapter, MSW)
├── scripts/          # Auth scripts
├── vitest.config.ts  # workspace-local vitest config (still here)
└── docs/
```

**Stack**: npm workspaces + Turborepo, orchestrated from the Kagami root (internal packages pattern — libraries export raw `.ts` source, only apps build). Shared lint/tsconfig bases come from `@kagami/eslint-config` and `@kagami/tsconfig`.

## Commands

All commands run from the **Kagami workspace root** (`/Kagami/`), not from `kokoro/`. The Kagami-root `package.json` exposes namespaced scripts that delegate to Kokoro:

```bash
npm run kokoro:dev             # bot + dashboard (Kokoro-only)
npm run kokoro:dev:bot         # just the bot (tsx watch)
npm run kokoro:dev:dashboard   # just the dashboard
npm run kokoro:auth:google     # tsx kokoro/scripts/authorize-google.ts
./dev-all.sh                   # boot Kioku → Kokoro + Kizuna together
```

For tests, lint, typecheck — run from the Kagami root and target Kokoro via Turborepo filters or `cd`:

```bash
npx turbo run typecheck --filter="@kokoro/*"
npx turbo run lint     --filter="@kokoro/*"
npx turbo run test     --filter="@kokoro/*"   # if any package has a `test` script
cd kokoro && npx vitest run                    # workspace vitest config still lives here
cd kokoro && npx vitest                         # watch mode
```

The dashboard dev server runs under [Portless](https://github.com/vercel-labs/portless) at `https://kokoro.localhost` (HTTPS auto-trusted, port assigned dynamically). First run prompts once for sudo to install the local CA.

## Dependency Graph

```
@kokoro/shared  ← config, logger, markdown, types
       ↑
@kokoro/db      ← mongoose, models, GridFS
       ↑
@kokoro/memory  ← Kioku client + conversation→transcript glue + session-close ingest
       ↑
@kokoro/bot     ← AI layer, tools, platform adapter, schedulers
@kokoro/dashboard ← Next.js (routine management, observability)
```

Lint and tsconfig bases (`@kagami/eslint-config`, `@kagami/tsconfig`) come from the Kagami workspace, not from inside Kokoro.

## Conventions

- **TypeScript + ESM** — strict mode, ES2022 target, ESNext modules. `verbatimModuleSyntax: true` is now applied **per-tsconfig.json** as an override (the new shared `@kagami/tsconfig/base.json` doesn't enable it by default, so each Kokoro tsconfig sets it explicitly to preserve the previous behavior).
- **Async everywhere** — all I/O is async/await, no callbacks
- **Zod for config** — environment variables validated at startup via `@kokoro/shared` config
- **Pino logging** — structured logs, use `logger.info({ context }, "message")` pattern
- **Vercel AI SDK** — `generateText()` from `ai` package for all LLM calls
- **No classes for services** — prefer standalone exported functions
- **Platform-agnostic types** — `IncomingMessage`/`PlatformAdapter` in `@kokoro/shared`
- **Cross-package imports** — use `@kokoro/shared`, `@kokoro/db`, `@kokoro/memory` for Kokoro-internal packages, and `@kagami/eslint-config` / `@kagami/tsconfig` for shared workspace tooling. Never use relative paths across package boundaries.
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
