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

**Current status:** **Kokoro migrated, Kizuna pending.** Kokoro now vends
its Google access tokens from Kao (the only previously-plaintext refresh
token in the workspace is gone). Kizuna's cutover is the next migration PR;
it still runs its own encrypted-Mongo + web-flow OAuth.

## Request flow

```
Operator browser
  GET /                         inline-HTML grant list + Connect links (open@localhost)
  GET /oauth/:grant/start       open@localhost; mint grant-bound CSRF state; 302 → Google consent
                                (scopes pulled from grant-registry, never the request)
  Google → GET /oauth/callback  verify signed state (recovers + binds grant);
                                exchange code; require refresh_token; AES-256-GCM
                                encrypt; upsert grants doc; clear that grant's
                                access-token cache; inline success page

Sibling service (Kokoro live; Kizuna pending)
  GET /grants/:grant/token      bearer KAO_TOKEN required; decrypt refresh;
                                refresh via google-auth-library (per-grant
                                30s-buffer cache); → { accessToken, expiresAt, scopes }
  GET /grants            list   bearer; registry-driven status for every grant
  GET /grants/:grant            bearer; single status
  DELETE /grants/:grant         bearer; best-effort Google revoke + soft local revoke
```

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
| `src/storage/mongo.ts`   | raw driver, lazy singleton, cached connect promise                                                                                     |
| `src/storage/grants.ts`  | `grants` collection: `getGrant`, `listGrants`, `upsertGrant`, `revokeGrant` (soft), `ensureGrantIndexes`                               |
| `src/routes/health.ts`   | `GET /healthz`                                                                                                                         |
| `src/routes/oauth.ts`    | `GET /:grant/start`, `GET /callback` (open@localhost, CSRF-state-defended)                                                             |
| `src/routes/grants.ts`   | the vend surface (mounted behind the bearer)                                                                                           |
| `src/routes/home.ts`     | inline-HTML operator page (`GET /`)                                                                                                    |

## Data model — `grants` collection

One document per named grant; `name` is the natural key (unique index).

```ts
interface GrantDoc {
  name: string; // "kizuna" | "kokoro" — unique
  scopes: string[]; // the registry scope set consented for
  refreshToken: string | null; // AES-256-GCM envelope; null after revoke
  googleSub: string | null; // reserved (identity sanity) — not captured yet
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
