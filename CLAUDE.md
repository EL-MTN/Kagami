# CLAUDE.md

## Project

Kagami ("mirror") is a personal-AI workspace composed of three independent TypeScript projects that can be developed and run together. The names are Japanese: **Kioku** (記憶, memory), **Kizuna** (絆, bond/relationship), **Kokoro** (心, heart/mind).

This file is the workspace-level guide. Each project has its own deeper `CLAUDE.md` and `docs/` — start here for cross-cutting context, then descend.

## Workspace Structure

```
Kagami/
├── ARCHITECTURE.md     # full cross-service map (auth, endpoints, env vars, coupling notes)
├── dev-all.sh          # boot Kioku → Kokoro + Kizuna with prefixed output
├── CLAUDE.md           # this file
│
├── Kioku/              # long-term memory store (apps/api + apps/dashboard)
│   ├── CLAUDE.md
│   └── docs/           # architecture, ingest, retrieval, storage, api, dashboard, …
│
├── Kokoro/             # Telegram + iMessage AI agent (apps/bot + apps/dashboard)
│   ├── CLAUDE.md
│   └── docs/           # architecture, ai-layer, memory, telegram, watchers, routines, …
│
└── Kizuna/             # personal CRM (apps/api + apps/dashboard)
    ├── CLAUDE.md
    └── docs/
```

The three projects are **separate git repositories** rooted at `Kioku/`, `Kokoro/`, `Kizuna/`. The Kagami root is a workspace folder, not a repo — `dev-all.sh` and `ARCHITECTURE.md` live here for convenience.

## How they relate

```
Kokoro ──HTTP──► Kioku            Kokoro reads/writes facts via REST.
                                  KIOKU_URL defaults to https://api.kioku.localhost.
Kizuna ────X──── Kioku/Kokoro     No code references in either direction.
Kioku  ────X──── anything         Pull-only by design; never initiates outbound to siblings.
```

`dev-all.sh` enforces the only real ordering constraint: **Kioku starts first** (2 s sleep), then Kokoro and Kizuna in parallel. Kokoro tolerates Kioku starting late (its memory client is fail-open with a 5-min sweeper retry), but the sequence keeps the first memory operations clean.

See `ARCHITECTURE.md` for the full edge table, endpoint surface, and per-project env-var cheat sheet.

## Commands

```bash
./dev-all.sh             # boot all three with prefixed output ([Kioku] / [Kokoro] / [Kizuna])
                         # Ctrl-C terminates all
```

Each project has its own scripts; check that project's `CLAUDE.md` for the full set. Rough convention across all three:

```bash
npm run dev              # Portless dev server(s) for that project
npm run typecheck        # turbo run typecheck
npm run test             # turbo run test
npm run lint             # turbo run lint
npm run format           # prettier --write
```

## Local hosting via Portless

All HTTP entry points are served as HTTPS named URLs by [Portless](https://github.com/vercel-labs/portless) (Vercel Labs reverse proxy). First run prompts once for sudo to install a local CA; HTTPS is auto-trusted thereafter. Portless picks an ephemeral port per app and binds 443.

| Project | Component | URL                              |
| ------- | --------- | -------------------------------- |
| Kioku   | dashboard | `https://kioku.localhost`        |
| Kioku   | API       | `https://api.kioku.localhost`    |
| Kokoro  | dashboard | `https://kokoro.localhost`       |
| Kokoro  | bot       | (none — Telegram long-poll)      |
| Kizuna  | dashboard | `https://kizuna.localhost`       |
| Kizuna  | API       | `https://api.kizuna.localhost`   |

Numeric `PORT` defaults inside each app (Kioku 7777, Kizuna 3000/3001) only matter when running standalone outside Portless.

## Shared conventions

All three projects converge on the same stack and layout, even though no code is shared between them:

- **Language**: TypeScript (strict, ESM), Node ≥ 22
- **Package layout**: monorepo via npm workspaces + Turborepo
- **Apps split**: `apps/api` (or `apps/bot` for Kokoro) + `apps/dashboard`
- **Internal packages**: each repo has its own `packages/eslint-config` and `packages/typescript-config` (not shared across repos)
- **Local dev hosting**: Portless via stable HTTPS named `*.localhost` URLs
- **Database**: MongoDB (Mongoose in Kizuna and Kokoro; raw driver in Kioku)
- **Logging**: Pino (structured)
- **Validation**: Zod schemas at boundaries
- **Formatting**: Prettier; ESLint flat config

## Per-project entry points

When working inside a project, consult that project's `CLAUDE.md` first — it's authoritative for module structure, conventions, and the docs index.

| Project | Role                          | Start here                                   |
| ------- | ----------------------------- | -------------------------------------------- |
| Kioku   | Long-term memory service      | [`Kioku/CLAUDE.md`](Kioku/CLAUDE.md)         |
| Kokoro  | Telegram + iMessage AI agent  | [`Kokoro/CLAUDE.md`](Kokoro/CLAUDE.md)       |
| Kizuna  | Personal CRM                  | [`Kizuna/CLAUDE.md`](Kizuna/CLAUDE.md)       |

For cross-service detail (Kokoro→Kioku coupling, Google OAuth duplication between Kioku and Kizuna, observed gaps), see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Working in this workspace

- **Scope changes to one project at a time.** A change in `Kokoro/` is committed in Kokoro's repo; same for the others. The Kagami root has no commit history.
- **Cross-service edits** (e.g. changing the Kokoro→Kioku contract) need two commits — one per repo. The Kioku side is producer; ship it first so Kokoro doesn't ship against an unreleased shape.
- **`ARCHITECTURE.md` is the source of truth for cross-service facts.** Update it when an edge is added, removed, or its shape changes (URLs, env vars, auth model, coupling direction).
- **Per-project docs (`<Project>/docs/`) are the source of truth for that project's internals.** Update them when modules, schemas, endpoints, or conventions change.
