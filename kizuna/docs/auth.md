# Auth

Single-user-per-deployment, single-machine, localhost-only. The OS user boundary is the trust boundary; there is no API-level authentication. The resource routes accept any caller that can reach `https://api.kizuna.localhost`, and the dashboard at `https://kizuna.localhost` is open.

Kizuna no longer owns a Google refresh token. Identity for the Gmail + Calendar ingest is delegated to the **Kao** identity service in the same workspace; Kizuna asks Kao for a short-lived Google access token on demand and never sees the refresh token at all. Consent (and re-consent after `invalid_grant`) happens at Kao's UI, not Kizuna's.

The only credentials Kizuna still holds in process are:

- **`KAO_TOKEN`** — the bearer Kizuna sends to Kao's `/grants/kizuna/token` endpoint. Treated as a shared secret with the local Kao instance; not a per-user credential.
- **`USER_EMAILS`** — used only to identify which inbox addresses count as "self" during ingest, not for authentication.

## At a glance

| Layer                   | Mechanism                                                                                                                  | Source                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Resource routes (API)   | none — open at localhost                                                                                                   | —                                |
| Google access tokens    | vended on demand by Kao via `GET ${KAO_URL}/grants/kizuna/token` (bearer `KAO_TOKEN`); cached in-process for the token TTL | `apps/api/src/lib/kao-client.ts` |
| Google consent flow     | owned by Kao at `${KAO_URL}/oauth/kizuna/start`; Kizuna only links out to it                                               | (none — moved to Kao)            |
| Refresh token at rest   | held by Kao only, AES-256-GCM under `KAO_ENCRYPTION_KEY`                                                                   | (none in Kizuna)                 |
| Dashboard sessions      | none — dashboard is open at localhost                                                                                      | —                                |
| Ingest "self" detection | `USER_EMAILS` allowlist (lowercased, comma-separated)                                                                      | `apps/api/src/config.ts`         |

## Vending an access token

The Gmail and Calendar ingest workers receive an injected `getAccessToken: () => Promise<string>` callback. That callback resolves to `getAccessToken(config, { force? })` in [`apps/api/src/lib/kao-client.ts`](../apps/api/src/lib/kao-client.ts), which:

1. Returns the cached token immediately if `expiresAt > now + 30 s`.
2. Otherwise (or on cold cache), `GET ${KAO_URL}/grants/kizuna/token` with `Authorization: Bearer ${KAO_TOKEN}` and a 5 s timeout (via `tracedFetch` so the active span propagates).
3. Validates the response body (`{ accessToken: string, expiresAt: number }`, with sanity bounds on `expiresAt`) and caches it for the TTL.

Concurrent cold-cache callers (Gmail + Calendar in the same scheduler tick) share one in-flight fetch via an `inflight` slot; the cache write is gated on `inflight === p` so a slow stale fetch resolving after a `force` cannot clobber the fresh value.

`force: true` clears the local cache AND appends `?force=1` to the vend URL so Kao also bypasses its own 30 s buffer and round-trips Google. This is the recovery lever after re-consenting at Kao when a Google revocation happened mid-window: without it, both caches would re-vend the dead token until its expiry lapses.

## OAuthError taxonomy

`kao-client.ts` re-exports an `OAuthError` with the same shape the old in-process flow exposed, so the ingest workers' branch logic is unchanged. Every Kao response is mapped into it:

| Kao response                                    | `OAuthError.code` | `result.status` | Side effect on `SyncState`                                                                                        |
| ----------------------------------------------- | ----------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `200` with valid body                           | (no error)        | `ok`            | cursor advances, `lastRunAt` set                                                                                  |
| `409` with `details.code: "no_grant"`           | `no_grant`        | `no_grant`      | None — empty run                                                                                                  |
| `409` with `details.code: "invalid_grant"`      | `invalid_grant`   | `paused`        | `pauseWith('invalid_grant')`                                                                                      |
| `409` with `details.code: "decrypt_failed"`     | `invalid_grant`   | `paused`        | `pauseWith('invalid_grant')` — re-consent at Kao writes a fresh ciphertext under the current `KAO_ENCRYPTION_KEY` |
| `401` (bad bearer) / `404` (grant unregistered) | `refresh_failed`  | `error`         | `lastError` written, `errorCount++`                                                                               |
| `502` (Google rejected refresh, transient)      | `refresh_failed`  | `error`         | `lastError` written, `errorCount++`                                                                               |
| network / timeout / malformed body              | `refresh_failed`  | `error`         | `lastError` written, `errorCount++`                                                                               |
| missing `KAO_TOKEN` at vend time                | `refresh_failed`  | `error`         | `lastError` written, `errorCount++`                                                                               |

`gmail.ts` additionally maps a `401` from Gmail mid-batch to `OAuthError("invalid_grant")` so a server-side revocation mid-run pauses the worker rather than just logging.

## Putting it together — typical flows

### First-time setup (operator)

1. Stand up Kao (`kao/CLAUDE.md`): set up its `KAO_ENCRYPTION_KEY`, Google OAuth client creds, and `KAO_TOKEN`.
2. In Kizuna's `apps/api/.env`: set `KAO_URL=https://api.kao.localhost` and `KAO_TOKEN=<same value as Kao's KAO_TOKEN>`. Set `USER_EMAILS`, `MONGODB_URI`. Restart the API.
3. Visit `https://kizuna.localhost/sync` — the "Grant / re-consent in Kao" button links out to `${KAO_URL}/oauth/kizuna/start`.
4. Consent on Google via Kao's flow. Kao stores the encrypted refresh token under the `kizuna` grant in its own DB.
5. Click "Run sync now" on the Gmail / Calendar cards — Kizuna vends an access token from Kao and ingests.

### Re-authorize after `invalid_grant`

1. Worker pauses; `SyncState.pausedAt` is set, `lastError = "invalid_grant — re-grant required"`.
2. Operator visits `/sync`, clicks "Grant / re-consent in Kao" — completes the Google flow at Kao again.
3. Operator returns to Kizuna and clicks **Force-run (clear pause)** on the paused worker. The route clears `pausedAt` and re-runs with `force: true`, which drops Kizuna's cached (dead) token AND tells Kao to bypass its own cache.

### Concierge / programmatic caller

1. POST directly to `/people`, `/interactions`, `/followups`, etc. No auth header. Source is auto-set to `'concierge'`.
2. List endpoints support cursor pagination via `?cursor=…`.

## `USER_EMAILS` allowlist

Comma-separated, lowercased, validated as `email` by zod. Used by both ingest workers for **skip-self on group threads** (drop `USER_EMAILS` from `to/cc/attendees` when ≥ 2 other recipients remain). The `from` role is preserved either way so outbound detection still works.

This is also the only piece of identity context the dashboard needs; it's read on the server side via `process.env.USER_EMAILS` in `apps/dashboard/src/lib/api.ts` to compute the inbound/outbound badge on a person's interaction list.

There is **no per-request user identification** — every `USER_EMAILS` address is implicitly "the user."

## Threat model

What the localhost-only / no-API-auth posture does and doesn't defend against:

- **OS user boundary.** Anyone running as the operating-system user can reach the API and read/write the DB directly. That's the trust boundary; no application-level credential changes it.
- **Other dev tools on the same machine.** Could hit the API if pointed at it. Not defended against; not realistic for a personal dev box.
- **Browser-side attacks (DNS rebinding, malicious sites visited by the user).** Mitigated by HTTPS-on-localhost + browser CORS defaults; the API itself does not enable permissive CORS.
- **External OAuth callback collisions.** No longer applicable to Kizuna — the callback lives at Kao now, and Kao protects it with its own signed CSRF state.
- **Refresh-token leakage via filesystem snapshots / dotfile backups.** Kizuna no longer stores a refresh token; this risk has moved to Kao (which keeps it AES-256-GCM-encrypted under `KAO_ENCRYPTION_KEY`).
- **`KAO_TOKEN` leakage.** If an attacker steals `KAO_TOKEN` AND can reach `api.kao.localhost`, they can vend access tokens for the `kizuna` grant. Mitigation: localhost-only Kao + treating `KAO_TOKEN` like a shared bearer (rotate by updating both Kao and Kizuna's `.env`).

If any of these stop being true (the API gets exposed beyond localhost, the host gets shared, multi-user lands), reintroduce a bearer or scoped credential before exposure — do not assume localhost trust elsewhere.
