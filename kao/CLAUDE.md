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

> **Status: Kokoro migrated, Kizuna pending.** Kokoro now reads short-lived
> access tokens from `${KAO_URL}/grants/kokoro/token` (the only previously-
> plaintext Google refresh token in Kagami is gone). Kizuna still runs its
> own encrypted-Mongo + web-flow OAuth; its cutover to
> `${KAO_URL}/grants/kizuna/token` is the remaining follow-up.
> **Kioku has no Google OAuth and is not a consumer** (an earlier
> `ARCHITECTURE.md` revision misattributed it — corrected).

Kao is a Kagami subtree-sibling (added natively, not via `git subtree`). It
consumes `@kagami/eslint-config`, `@kagami/tsconfig`, and `@kagami/logger`
from `Kagami/shared/packages/`. No top-level `package.json`/`turbo.json`.

## Monorepo Structure

```
kao/
├── apps/
│   ├── api/                    # Express HTTP API (entry: src/main.ts)
│   │   ├── src/
│   │   │   ├── main.ts             # boot: loadConfig → connectMongo → ensureGrantIndexes → createApp
│   │   │   ├── server.ts           # Express app; bearer-gates /grants/*, leaves /oauth/* open@localhost
│   │   │   ├── config.ts           # zod env schema; callbackUrl() derives the single redirect URI
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
