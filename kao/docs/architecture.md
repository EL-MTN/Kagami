# Architecture

Kao is a single Express API that owns Google OAuth refresh tokens for the
workspace and vends short-lived access tokens to sibling services. One Google
identity; **per-consumer scoped grants**.

## Why Kao exists

Before Kao, two services did Google OAuth independently and divergently:

|         | Kizuna                                              | Kokoro                                         |
| ------- | --------------------------------------------------- | ---------------------------------------------- |
| Flow    | web auth-code (`/oauth/google/start` + `/callback`) | CLI out-of-band paste                          |
| Storage | Mongo, AES-256-GCM encrypted                        | **plaintext `apps/bot/.env`**                  |
| Library | `google-auth-library`                               | `googleapis`                                   |
| Scopes  | gmail.readonly + calendar.readonly                  | gmail.readonly + gmail.send + calendar (write) |

Kioku has **no** Google OAuth (no deps, no creds) — it never did. Kao
consolidates Kizuna + Kokoro only. It ports Kizuna's encryption and CSRF-state
modules (the stronger implementation) and replaces Kokoro's plaintext storage.

**Current status:** **Both consumers migrated.** Kokoro and Kizuna both
vend Google access tokens from Kao at runtime; Kokoro's plaintext
`GOOGLE_OAUTH_REFRESH_TOKEN` and Kizuna's encrypted-Mongo + web-flow
OAuth (`encryption.ts`, `oauth-state.ts`, `OAuthToken` Mongoose model,
`google-auth-library` dep) are all gone.

## Request flow

```
Operator browser (dashboard: https://kao.localhost)
  GET https://kao.localhost/           Next.js — grants overview (Server Component → /grants)
  GET https://kao.localhost/grants/:n  Next.js — per-grant detail + Revoke + Token Probe
  → Server Action revokeGrantAction    Next.js server → DELETE /grants/:n (bearer KAO_TOKEN)
  → Server Action probeGrantAction     Next.js server → GET   /grants/:n/token?force=1

Operator browser (API origin: https://api.kao.localhost)
  GET /                         inline-HTML grant list + Connect links (open@localhost — fallback)
  GET /oauth/:grant/start       open@localhost; mint grant-bound CSRF state; 302 → Google consent
                                (scopes pulled from grant-registry, never the request)
  Google → GET /oauth/callback  verify signed state (recovers + binds grant);
                                exchange code; require refresh_token; AES-256-GCM
                                encrypt; upsert grants doc; clear that grant's
                                access-token cache; inline success page linking back to
                                ${KAO_DASHBOARD_URL}/grants/:n so the round-trip ends on
                                the dashboard

Sibling service (Kokoro and Kizuna both live)
  GET /grants/:grant/token      bearer KAO_TOKEN required; decrypt refresh;
                                refresh via google-auth-library (per-grant
                                30s-buffer cache); → { accessToken, expiresAt, scopes }
  GET /grants            list   bearer; registry-driven status for every grant
  GET /grants/:grant            bearer; single status
  DELETE /grants/:grant         bearer; best-effort Google revoke + soft local revoke
```

## Dashboard (apps/dashboard)

`@kao/dashboard` is a Next.js 16 (App Router, RSC) app served by Portless at
`https://kao.localhost`. It exists to give operators a UI for the same surface
the inline-HTML operator page covers, plus revoke and a token probe.

| Page                      | Role                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/` (`src/app/page.tsx`)  | Lists every registry grant. Inline Connect/Re-consent (anchor → `${KAO_PUBLIC_URL}/oauth/:n/start`) and a two-step Revoke.   |
| `/grants/:grant` (detail) | Full audit timestamps + scope list + Revoke + **Token Probe** (force-refresh; surfaces live access token + expiry + scopes). |

**Bearer model.** `/grants/*` is bearer-gated; the dashboard runs every call
through its **server runtime** with `Authorization: Bearer ${KAO_TOKEN}`
injected from `apps/dashboard/.env`. No path through the page exposes that
bearer to the browser — Server Components fetch reads, Server Actions handle
writes (`revokeGrantAction`, `probeGrantAction`).

**OAuth consent links** are plain anchors to the API origin — the browser
must reach Google itself, and `/oauth/:grant/start` is open@localhost
(CSRF-state-defended). After consent succeeds, the API's inline callback page
links back to `${KAO_DASHBOARD_URL}/grants/:n` so the operator lands on the
dashboard's detail page (not the API's inline home).

**Probe semantics.** The probe calls `/grants/:grant/token?force=1`,
bypassing Kao's per-grant access-token cache so a green probe really means
"Google still likes the refresh token." Structured failures each render
their own next-step hint inline via the shared `lib/error-hints.ts`
`hintFor()` table. Codes come from two sources: the API's vend taxonomy
(`no_grant` / `invalid_grant` / `decrypt_failed` / `bad_gateway` /
`unauthorized` / `not_found`) and the dashboard's own client surfaces
(`misconfigured` when `KAO_TOKEN` is missing locally, `unreachable` when
the API can't be reached at all, and `malformed_response` when an
otherwise-200 response has an unexpected body shape).

**Why the inline-HTML home stays.** The API's `GET /` page is the fallback
when the dashboard isn't running (or hasn't been spun up yet on a fresh
checkout). It's still useful in standalone-API workflows, so it isn't being
deleted as part of the dashboard pass.

## Module map

| Path                     | Responsibility                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`            | boot: `loadConfig` → `connectMongo` → `ensureGrantIndexes` → `createApp` → listen; SIGINT/SIGTERM graceful close                       |
| `src/server.ts`          | Express app; mount order; **bearer middleware in front of `/grants`** only                                                             |
| `src/config.ts`          | zod env schema; `callbackUrl()` derives the one redirect URI from `KAO_PUBLIC_URL`                                                     |
| `src/grant-registry.ts`  | the version-controlled per-consumer scope map; `isGrantName` type guard; `scopesFor` returns a copy                                    |
| `src/lib/encryption.ts`  | AES-256-GCM envelope, ported verbatim from Kizuna (`KAO_ENCRYPTION_KEY`)                                                               |
| `src/lib/oauth-state.ts` | HMAC CSRF state, ported from Kizuna + **grant bound into the signed payload**; process-local secret, 10-min TTL                        |
| `src/lib/google.ts`      | OAuth2Client factory, consent URL, code exchange, per-grant access-token cache, refresh with `OAuthError` taxonomy, best-effort revoke |
| `src/lib/auth.ts`        | constant-time bearer check (SHA-256 both sides → `timingSafeEqual`, no length oracle)                                                  |
| `src/lib/errors.ts`      | `HttpError` + `errors` factory + Express error handler (envelope `{ error: { code, message, details? } }`)                             |
| `src/lib/html.ts`        | shared `escapeHtml` for the two inline operator pages (`home.ts` + the OAuth callback success page)                                    |
| `src/storage/mongo.ts`   | raw driver, lazy singleton, cached connect promise                                                                                     |
| `src/storage/grants.ts`  | `grants` collection: `getGrant`, `listGrants`, `upsertGrant`, `revokeGrant` (soft), `ensureGrantIndexes`                               |
| `src/routes/health.ts`   | `GET /healthz`                                                                                                                         |
| `src/routes/oauth.ts`    | `GET /:grant/start`, `GET /callback` (open@localhost, CSRF-state-defended)                                                             |
| `src/routes/grants.ts`   | the vend surface (mounted behind the bearer)                                                                                           |
| `src/routes/home.ts`     | inline-HTML operator page (`GET /`) — fallback for when the Next.js dashboard isn't running                                            |
| `apps/dashboard/`        | Next.js 16 (App Router, RSC) operator dashboard — bearer-injected server-side; see "Dashboard" below                                   |

## Data model — `grants` collection

One document per named grant; `name` is the natural key (unique index).

```ts
interface GrantDoc {
  name: string; // "kizuna" | "kokoro" — unique
  scopes: string[]; // the registry scope set consented for
  refreshToken: string | null; // AES-256-GCM envelope; null after revoke
  grantedAt: Date | null;
  revokedAt: Date | null; // soft revoke marker
  updatedAt: Date;
}
```

Revoke is soft: the secret is nulled and `revokedAt` stamped, but the row is
kept so status history and the prior scope set stay inspectable. A later
re-consent upserts a fresh token and clears `revokedAt`.

## Design decisions

- **Per-consumer grants, not one union token.** A single union-scope token
  would mean any Kao-authenticated caller could send mail as the user. Each
  grant carries only its consumer's scopes, so a Kizuna-side compromise
  cannot send mail. Least privilege is explicit in `grant-registry.ts`.
- **Single callback, grant in signed state.** Per-grant callbacks would mean
  N redirect URIs registered in Google Cloud. One `/oauth/callback` plus a
  grant-bound CSRF state keeps Google config to a single URI and makes
  callback-replay-against-another-grant a signature failure.
- **Scopes from the registry, never the request.** `/oauth/:grant/start`
  ignores any scope hint; consent width is code, not input.
- **Raw Mongo driver.** One tiny collection — Mongoose would be dead weight.
  Matches Kioku's storage style.
- **Fail-closed vend, fail-open nothing.** Unlike the Kansoku shipper (which
  must never wedge a caller), Kao's job is to _gate_ a credential — a missing
  bearer is a hard 401, a rejected refresh is a structured 409 telling the
  consumer to re-consent. See `auth.md`.
