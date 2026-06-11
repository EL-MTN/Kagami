# CLAUDE.md

## Project

Kao (顔, "face"/identity) — the workspace's Google identity service. One Google
identity, **per-consumer scoped grants**: each consumer (`kizuna`, `kokoro`)
gets its own refresh token consented for only the scopes it needs, and reads
short-lived access tokens from Kao instead of owning a refresh token itself.

Kao consolidates the two pre-existing, divergent OAuth implementations:

- **Kizuna** — `google-auth-library`, web auth-code flow, refresh token
  AES-256-GCM encrypted in Mongo. (The stronger prior art; Kao ports its
  encryption + CSRF-state modules.)
- **Kokoro** — `googleapis`, CLI out-of-band paste, refresh token in
  **plaintext `.env`**.

> **Status: identity consolidation complete.** Both Kokoro and Kizuna now
> read short-lived access tokens from Kao at runtime
> (`${KAO_URL}/grants/{kokoro,kizuna}/token`). Kokoro's plaintext
> `GOOGLE_OAUTH_REFRESH_TOKEN` and Kizuna's encrypted-Mongo + web-flow
> OAuth (`encryption.ts`, `oauth-state.ts`, the `OAuthToken` Mongoose
> model, and the `google-auth-library` dep) are all gone. Kioku has no
> Google OAuth and is not a consumer.

Kao is a Kagami subtree-sibling (added natively, not via `git subtree`). It
consumes `@kagami/eslint-config`, `@kagami/tsconfig`, `@kagami/logger`, and
`@kagami/env` from `Kagami/shared/packages/`. No top-level `package.json`/`turbo.json`.

This file is the project guide. Cross-service facts live in the workspace root: see [`../CLAUDE.md`](../CLAUDE.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Monorepo Structure

```
kao/
├── apps/
│   ├── api/                    # Express HTTP API (entry: src/main.ts)
│   │   ├── src/
│   │   │   ├── main.ts             # boot: loadConfig → connectMongo → ensureGrantIndexes → createApp
│   │   │   ├── server.ts           # Express app; bearer-gates /grants/*, leaves /oauth/* open@localhost
│   │   │   ├── env.ts              # @kagami/env spec (zod schemas + doc metadata; generates .env.example/docs/turbo.json)
│   │   │   ├── config.ts           # thin loadConfig() over the spec; callbackUrl() derives the single redirect URI
│   │   │   ├── grant-registry.ts   # version-controlled per-consumer scope map (the least-privilege source of truth)
│   │   │   ├── lib/                # logger, errors, encryption (ported), oauth-state (ported + grant-bound), google, auth (bearer), html (shared escapeHtml)
│   │   │   ├── storage/            # mongo (raw driver, lazy singleton) + grants repository
│   │   │   └── routes/             # health, oauth (consent), grants (vend), home (inline operator page)
│   │   ├── tests/              # vitest + supertest + mongodb-memory-server
│   │   └── tsconfig.build.json # prod build: tsc -p this → dist/ (extends @kagami/tsconfig/server.build.json)
│   └── dashboard/              # Next.js 16 operator dashboard at https://kao.localhost
│       ├── src/
│       │   ├── app/
│       │   │   ├── layout.tsx          # sidebar shell + Mashiro Daylight fonts
│       │   │   ├── page.tsx            # grants overview (RSC; reads listGrants)
│       │   │   ├── grants/[grant]/     # per-grant detail (audit, scopes, Revoke, Token Probe)
│       │   │   ├── actions.ts          # Server Actions: revokeGrantAction, probeGrantAction
│       │   │   └── globals.css
│       │   ├── components/             # sidebar, nav-link, shell/, grant-badge, revoke-button, token-probe
│       │   └── lib/                    # api (server-side bearer injection), error-hints (shared hintFor), format, utils
│       ├── tsconfig.json       # extends @kagami/tsconfig/nextjs.json
│       ├── eslint.config.mjs   # imports from @kagami/eslint-config/next
│       └── package.json        # portless "kao"; Next 16 + React 19 + Tailwind 4
├── packages/                   # reserved for future Kao-only libs (currently empty)
├── portless.json               # api.kao + kao registrations
└── docs/
```

The dashboard lives next to the API as `@kao/dashboard`. It exists to surface
the same operations as the API's inline-HTML operator page — Connect / Revoke
— plus a **Token Probe** that bypasses Kao's per-grant access-token cache to
confirm a grant still works against Google. The inline-HTML home (`GET /` on
the API) stays as a fallback for standalone-API workflows; the dashboard is
the operator UI in normal local development.

## Commands

All commands run from the **Kagami workspace root**.

```bash
npm run kao:dev                 # both Kao apps under Portless (https://api.kao.localhost + https://kao.localhost)
npm run kao:dev:api             # API only
npm run kao:dev:dashboard       # Dashboard only
./dev-all.sh --only kao         # Kao alone via the multi-service launcher

npx turbo run typecheck --filter="@kao/*"
npx turbo run lint     --filter="@kao/*"
npx turbo run test     --filter="@kao/*"
npx turbo run build    --filter="@kao/*"   # api (tsc → dist/) + dashboard (next build)

cd kao && npx vitest            # all API tests via the shared vitest.config.ts
cd kao && npx vitest --watch
```

For production the API compiles via `tsconfig.build.json` (extends
`@kagami/tsconfig/server.build.json`, emit on): `npm run build` →
`tsc -p tsconfig.build.json` → `dist/`, started as plain `node dist/main.js`
(`start`) — same convention as the other compiled APIs.

## Conventions

- **TypeScript + ESM**, strict, NodeNext. Extends `@kagami/tsconfig/server.json`
  (so `noUncheckedIndexedAccess` + `verbatimModuleSyntax` are on). Within-app
  imports use relative paths with explicit `.js` extensions (NodeNext).
- **Zod at boundaries** — `config.ts` validates env at startup; route inputs
  are parsed/guarded in handlers. Required env throws on misconfig (Kao's
  whole purpose is OAuth, so Google creds + key + bearer are required, not
  optional like Kizuna's).
- **Raw MongoDB driver** (like Kioku), lazy singleton, one `grants`
  collection, unique on `name`. No Mongoose.
- **`@kagami/logger`** — `logger.ts` wraps the factory (`service: "kao-api"`),
  fail-open Kansoku shipper when `KANSOKU_URL` + `KANSOKU_INGEST_TOKEN` set,
  `traceMiddleware()` before routes.
- **No classes for services** — standalone exported functions; the only class
  is `HttpError` / `OAuthError` (error envelopes).
- **Auth posture is deliberately NOT open-at-localhost for the vend surface.**
  `/grants/*` always requires `Authorization: Bearer ${KAO_TOKEN}` (SHA-256 +
  `timingSafeEqual`). The `/oauth/*` consent flow is open@localhost, defended
  by an HMAC-signed CSRF state that **binds the grant name**. Rationale:
  Kao holds the single most sensitive credential in Kagami (a Google refresh
  token that, for `kokoro`, can send mail / write the calendar), and the
  workspace is headed for non-localhost exposure — see `docs/auth.md`.
- **Single redirect URI.** Per-grant `/oauth/:grant/start`, but one shared
  `/oauth/callback`; the grant travels in signed state, so only
  `${KAO_PUBLIC_URL}/oauth/callback` is registered in Google Cloud.
- **Scopes come from the registry, never the request.** A crafted
  `/oauth/:grant/start` cannot widen consent.
- **`.env` location** — `apps/api/.env`; `apps/api/.env.example` is the template.
- **Tests as source of truth** — when a test fails because production behaves
  differently than the test expects, fix the API, not the test.

## Where to find things

Common tasks → files. When a task touches multiple files, all are listed.

| Task                                             | File(s)                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a new consumer grant (e.g. another service)  | `apps/api/src/grant-registry.ts` (version-controlled scope map)                                                                                                     |
| Add an OAuth scope to an existing grant          | `apps/api/src/grant-registry.ts`                                                                                                                                    |
| Add a REST endpoint                              | New router in `apps/api/src/routes/<name>.ts` + mount in `apps/api/src/server.ts`                                                                                   |
| Add an env var                                   | `apps/api/src/env.ts` (`@kagami/env` spec: schema + doc metadata), then `npm run env:gen` — `.env.example`, the docs table, and `apps/api/turbo.json` are generated |
| Google OAuth token exchange / refresh / revoke   | `apps/api/src/lib/google.ts`                                                                                                                                        |
| Bearer-token auth middleware (gates `/grants/*`) | `apps/api/src/lib/auth.ts`                                                                                                                                          |
| CSRF state (grant-bound)                         | `apps/api/src/lib/oauth-state.ts`                                                                                                                                   |
| Refresh-token encryption at rest                 | `apps/api/src/lib/encryption.ts`                                                                                                                                    |
| Grants Mongo repository                          | `apps/api/src/storage/grants.ts`                                                                                                                                    |
| Inline operator page (no-dashboard fallback)     | `apps/api/src/routes/home.ts`                                                                                                                                       |
| Next.js operator dashboard                       | `apps/dashboard/src/app/page.tsx` (RSC; reads `listGrants`)                                                                                                         |
| Logger init                                      | `apps/api/src/lib/logger.ts`                                                                                                                                        |
| API server entrypoint                            | `apps/api/src/main.ts` (boot: `loadConfig → connectMongo → ensureGrantIndexes → createApp`); Express in `apps/api/src/server.ts`                                    |
| Tests                                            | `apps/api/tests/*.test.ts`                                                                                                                                          |

## Doc Maintenance

After any code change, update the relevant doc in `/docs`. If a new module or
major feature lands, add a doc. Cross-service facts (a consumer finally
migrating, the bearer/edge shape changing) go in the root `ARCHITECTURE.md`.

See `/docs` for:

- [architecture.md](docs/architecture.md) — request flow, module map, data model, boot sequence, design decisions
- [api.md](docs/api.md) — endpoint surface, the grant registry, error envelope, the vend contract consumers will call
- [auth.md](docs/auth.md) — why the vend surface is bearer-gated (not open@localhost), CSRF-state grant binding, encryption at rest, threat model, VPS-exposure note
- [configuration.md](docs/configuration.md) — env vars, key/bearer generation, Google Cloud client setup, Portless
- [testing.md](docs/testing.md) — vitest + supertest + mongodb-memory-server harness, what's covered, the deterministic-only stance on the Google refresh path
