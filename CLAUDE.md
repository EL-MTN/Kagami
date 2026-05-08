# CLAUDE.md

## Project

Kagami ("mirror") is a personal-AI workspace. It contains three sibling TypeScript projects in one nested monorepo: **Kioku** (記憶, memory), **Kizuna** (絆, bond/relationship), and **Kokoro** (心, heart/mind). They share tooling, a single `package.json` install, and a unified Turborepo pipeline, but each project is bounded — its apps, internal packages, docs, and `CLAUDE.md` live under its own subdirectory.

This file is the workspace-level guide. Each project has its own deeper `CLAUDE.md` and `docs/` — start here for cross-cutting context, then descend.

## Workspace Structure

```
Kagami/                       # one git repo, one workspace
├── ARCHITECTURE.md           # full cross-service map (auth, endpoints, env vars, coupling notes)
├── CLAUDE.md                 # this file
├── package.json              # workspace root: workspace globs + shared devDeps
├── turbo.json                # unified pipeline (build, dev, typecheck, test, lint)
├── dev-all.sh                # boot all three in parallel under Turbo's TUI (or streamed)
│
├── kioku/                    # long-term memory store
│   ├── apps/                 # api, dashboard
│   ├── docs/
│   ├── CLAUDE.md
│   ├── portless.json
│   └── vitest.config.ts
│
├── kokoro/                   # Telegram + iMessage AI agent
│   ├── apps/                 # bot, dashboard
│   ├── packages/             # shared, db, memory, test-utils
│   ├── scripts/              # auth scripts
│   ├── docs/
│   ├── CLAUDE.md
│   └── vitest.config.ts
│
├── kizuna/                   # personal CRM
│   ├── apps/                 # api, dashboard
│   ├── docs/
│   ├── CLAUDE.md
│   ├── portless.json
│   └── vitest.config.ts
│
└── shared/
    └── packages/
        ├── eslint-config/    # @kagami/eslint-config (./base, ./next)
        └── tsconfig/         # @kagami/tsconfig (./base.json, ./library.json, ./server.json, ./nextjs.json)
```

The Kagami root is the single git repo. The three project subtrees were imported via `git subtree add` so each project's prior history is preserved in `git log`. Each project still has its own `CLAUDE.md` and `docs/` next to its code.

## How they relate

```
Kokoro ──HTTP──► Kioku            Kokoro reads/writes facts via REST.
                                  KIOKU_URL defaults to https://api.kioku.localhost.
Kizuna ────X──── Kioku/Kokoro     No code references in either direction (yet).
Kioku  ────X──── anything         Pull-only by design; never initiates outbound to siblings.
```

`dev-all.sh` boots all three in parallel — there is no startup ordering between them. Kokoro's Kioku client is fail-open (`KiokuClientError` is caught at the AI tool layer; chat continues degraded), and any pending writes are retried by Kokoro's 5-min sweeper.

See `ARCHITECTURE.md` for the full edge table, endpoint surface, and per-project env-var cheat sheet.

## Commands

All commands run from the Kagami root.

```bash
./dev-all.sh                     # boot all three in parallel under Turbo's TUI
                                 # (per-task panes, single Ctrl-C stops all)
./dev-all.sh --no kokoro:bot     # selective: --only / --no take projects or
./dev-all.sh --only kioku        # components (e.g. kokoro:bot, kioku:dashboard)
./dev-all.sh --stream            # force streamed [prefix] output instead of TUI
npm run dev                      # alias for ./dev-all.sh
npm run typecheck                # turbo run typecheck across every workspace
npm run test                     # turbo run test
npm run lint                     # turbo run lint
npm run lint:fix
npm run build                    # turbo run build
npm run format                   # prettier --write all files

# Per-project filters
npm run kioku:dev                # turbo run dev --filter="@kioku/*"
npm run kokoro:dev
npm run kizuna:dev

# Per-component filters
npm run kioku:dev:api
npm run kioku:dev:dashboard
npm run kokoro:dev:bot
npm run kokoro:dev:dashboard
npm run kizuna:dev:api
npm run kizuna:dev:dashboard

# Project-specific scripts
npm run kokoro:auth:google       # tsx kokoro/scripts/authorize-google.ts
```

`npm install` is hoisted at the Kagami root. There is no per-project `package.json` and no per-project `node_modules` install step.

## Local hosting via Portless

All HTTP entry points are served as HTTPS named URLs by [Portless](https://github.com/vercel-labs/portless) (Vercel Labs reverse proxy). First run prompts once for sudo to install a local CA; HTTPS is auto-trusted thereafter. Portless picks an ephemeral port per app and binds 443.

| Project | Component | URL                            |
| ------- | --------- | ------------------------------ |
| Kioku   | dashboard | `https://kioku.localhost`      |
| Kioku   | API       | `https://api.kioku.localhost`  |
| Kokoro  | dashboard | `https://kokoro.localhost`     |
| Kokoro  | bot       | (none — Telegram long-poll)    |
| Kizuna  | dashboard | `https://kizuna.localhost`     |
| Kizuna  | API       | `https://api.kizuna.localhost` |

Each project keeps its own `portless.json` next to its code. Numeric `PORT` defaults inside apps only matter when running an app standalone outside Portless; normal local development should use the named HTTPS URLs above.

## Shared conventions

All three projects share tooling via `shared/packages/`:

- **`@kagami/eslint-config`** — flat ESLint config; `./base` for general TS, `./next` for Next.js apps.
- **`@kagami/tsconfig`** — `./base.json`, `./library.json`, `./server.json`, `./nextjs.json`. Per-app `tsconfig.json` files extend one of these and add overrides (e.g. `verbatimModuleSyntax`, `esModuleInterop`, `noImplicitOverride`, `allowImportingTsExtensions`, `allowJs`) where projects diverge.

Other workspace-wide conventions:

- **Language**: TypeScript (strict, ESM), Node ≥ 22
- **Package layout**: nested monorepo via npm workspaces + Turborepo. Workspace globs are `kioku/{apps,packages}/*`, `kokoro/{apps,packages}/*`, `kizuna/{apps,packages}/*`, and `shared/packages/*`.
- **Apps split**: `apps/api` (or `apps/bot` for Kokoro) + `apps/dashboard`
- **Local dev hosting**: Portless via stable HTTPS named `*.localhost` URLs
- **Database**: MongoDB (Mongoose in Kizuna and Kokoro; raw driver in Kioku)
- **Logging**: Pino (structured)
- **Validation**: Zod schemas at boundaries
- **Formatting**: Prettier; ESLint flat config

### Husky + lint-staged

Live at the workspace root. The `prepare` script runs `husky` after install; the `.husky/pre-commit` hook runs `npx lint-staged` on staged files. Each project's prior `.husky/` was removed during migration.

Lint-staged globs:

- `**/apps/**/src/**/*.{ts,tsx}` and `**/packages/**/*.ts` — `eslint --fix` + `prettier --write` (per-project ESLint configs cover these paths)
- `**/apps/**/{tests,scripts}/**/*.{ts,tsx}` and `**/scripts/**/*.ts` — `prettier --write` only (ESLint coverage of these paths varies per project, so they're prettier-only to avoid surfacing lint regressions on previously-uncovered code)
- `**/*.{json,md}` — `prettier --write`

## Per-project entry points

When working inside a project, consult that project's `CLAUDE.md` first — it's authoritative for module structure, conventions, and the docs index.

| Project | Role                         | Start here                             |
| ------- | ---------------------------- | -------------------------------------- |
| Kioku   | Long-term memory service     | [`kioku/CLAUDE.md`](kioku/CLAUDE.md)   |
| Kokoro  | Telegram + iMessage AI agent | [`kokoro/CLAUDE.md`](kokoro/CLAUDE.md) |
| Kizuna  | Personal CRM                 | [`kizuna/CLAUDE.md`](kizuna/CLAUDE.md) |

For cross-service detail (Kokoro→Kioku coupling, observed gaps, planned Kao identity service), see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Working in this workspace

- **One repo, one PR flow.** Cross-service edits (e.g. changing the Kokoro→Kioku contract) can be a single commit/PR now. Producers should still ship before consumers in the same commit, and tests should cover both sides.
- **`ARCHITECTURE.md` is the source of truth for cross-service facts.** Update it when an edge is added, removed, or its shape changes (URLs, env vars, auth model, coupling direction).
- **Per-project docs (`<project>/docs/`) are the source of truth for that project's internals.** Update them when modules, schemas, endpoints, or conventions change.
- **Adding a new service** (e.g. Kao for OAuth state): create `kao/` at the top level with its own `apps/`, `packages/`, `docs/`, `CLAUDE.md`, and add `kao/{apps,packages}/*` to the root `package.json` workspaces array.
