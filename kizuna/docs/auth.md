# Auth

Single-user-per-deployment, single-machine, localhost-only. The OS user boundary is the trust boundary; there is no API-level authentication. The resource routes accept any caller that can reach `https://api.kizuna.localhost`, and the dashboard at `https://kizuna.localhost` is open.

Google access is **delegated to the Kao identity service** — Kizuna does not own a Google refresh token. Kao stores the encrypted refresh token, hosts the consent flow, and vends short-lived access tokens to Kizuna over HTTP. The only credentials Kizuna still owns are:

- `KAO_TOKEN`, a bearer that gates Kao's `/grants/kizuna/token` endpoint.
- `USER_EMAILS`, used only to identify which inbox addresses count as "self" during ingest.

## At a glance

| Layer                      | Mechanism                                                                                                                | Source                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| resource routes (API)      | none — open at localhost                                                                                                 | —                                     |
| `POST /oauth/google/start` | 303 → `${KAO_URL}/oauth/kizuna/start` (POST; same-origin Origin check; clears paused workers' `pausedAt` + `errorCount`) | `apps/api/src/routes/oauth.ts`        |
| `/oauth/google/status`     | reads `${KAO_URL}/grants/kizuna` with `Authorization: Bearer ${KAO_TOKEN}`, reshapes                                     | `apps/api/src/routes/oauth.ts`        |
| Google refresh token       | stored encrypted in Kao's Mongo; never reaches Kizuna's process                                                          | `kao/apps/api/src/lib/encryption.ts`  |
| Google access token        | vended on demand from Kao; 30s-buffer in-process cache in Kizuna                                                         | `apps/api/src/lib/kao-client.ts`      |
| CSRF on consent flow       | HMAC-signed state bound to the grant name; minted by Kao                                                                 | `kao/apps/api/src/lib/oauth-state.ts` |
| Dashboard sessions         | none — dashboard is open at localhost                                                                                    | —                                     |
| Ingest "self" detection    | `USER_EMAILS` allowlist (lowercased, comma-separated)                                                                    | `apps/api/src/config.ts`              |

## OAuth grant flow

The consent flow lives entirely in Kao. Kizuna's `POST /oauth/google/start` is a 303 redirect to `${KAO_URL}/oauth/kizuna/start`, so the dashboard's "Connect Google" / "Re-authorize" button (now a `<form method="post">`) keeps working. The Google Cloud OAuth client is registered with **one** redirect URI — `${KAO_PUBLIC_URL}/oauth/callback` — and Kao routes responses back to the right grant via its signed CSRF state. POST is intentional: a GET that mutates SyncState would be reachable by browser preloaders, link unfurlers, and `<img src>` tags; an Origin check (allowlist of `https://kizuna.localhost` plus any `KIZUNA_DASHBOARD_ORIGIN` extras) defends against cross-origin form-CSRF from a malicious tab.

After consent, the operator lands on Kao's success page; the grant is persisted under the name `kizuna` (read-only Gmail + Calendar — see `kao/apps/api/src/grant-registry.ts`). The next sync run vends an access token from Kao and proceeds normally.

A re-grant invalidates Kao's cached access token for the `kizuna` grant immediately. Kizuna does **not** auto-unpause paused workers after a re-grant (Kao has no knowledge of Kizuna's `SyncState`); manually trigger `POST /sync/{gmail,gcal}/run` with `{ "force": true }` after re-authorizing, or wait for the next scheduler tick.

### `POST /oauth/google/start` (Kizuna)

Validates that `KAO_URL` + `KAO_TOKEN` are set (otherwise `400`) and that the `Origin` header, if present, is in the allowlist (`https://kizuna.localhost` plus any `KIZUNA_DASHBOARD_ORIGIN` extras); otherwise `401`. Clears `pausedAt` and resets `errorCount` on any SyncState row with `pausedAt: {$type: "date"}`, then drops the local access-token cache. Redirects 303 to `${KAO_URL}/oauth/kizuna/start`. `lastError` is intentionally NOT cleared here — recordSuccessfulRun/recordIdleRun handle it on the next tick.

### `GET /oauth/google/status` (Kizuna)

Open. Server-side GETs `${KAO_URL}/grants/kizuna` with the bearer, then reshapes Kao's response into the legacy `OAuthStatus` envelope the dashboard already understands:

```json
{ "granted": false }
```

```json
{
  "granted": true,
  "scopes": ["https://...gmail.readonly", "https://...calendar.readonly"],
  "grantedAt": "2026-04-01T..."
}
```

Kao unreachable, bearer rejected, or grant absent all collapse to `{ granted: false }` — the dashboard UX in that case is "Connect Google", which is the right action.

## Access-token cache and self-heal retry

`apps/api/src/lib/kao-client.ts`:

```ts
let cache: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

getAccessToken(config, { force? }) =>
  if force: clear cache+inflight, then vend with ?force=1
  else: return cached if expiresAt > now + 30s; else share inflight; else fetch
```

Kao also caches with a 30s safety buffer — both layers agree on "treat expiring-soon as expired" so a refresh stays comfortably ahead of any in-flight Google call. The `force` query parameter tells Kao to bypass **its** cache and round-trip to Google; without it, Kao's cache could re-vend a dead token until expiry lapses.

`clearAccessTokenCache()` clears both `cache` and `inflight` together — clearing only `cache` would let a stale in-flight fetch overwrite `cache` with the old token a moment later.

The Gmail and Calendar HTTP clients (`apps/api/src/ingest/gmail-client.ts` and `apps/api/src/ingest/calendar-client.ts`) wrap each Google call in a self-heal retry: on a 401 or 403 from Google, they ask `getAccessToken({ force: true })`, retry once, and only propagate a failure if Google rejects the _fresh_ token too. A persistent 401 after the retry still escapes as `GmailHttpError(401)` / `CalendarHttpError(401)`, which the worker maps to `OAuthError('invalid_grant')` and pauses the worker on.

`OAuthError` codes returned by `getAccessToken`:

| `OAuthError.code`    | Origin                                                          | `result.status` | Side effect on `SyncState`                            |
| -------------------- | --------------------------------------------------------------- | --------------- | ----------------------------------------------------- |
| `'no_grant'`         | Kao 409 with `code:'no_grant'` (no consent yet / grant revoked) | `'no_grant'`    | None — no row to mutate                               |
| `'invalid_grant'`    | Kao 409 with `code:'invalid_grant'` or `'decrypt_failed'`       | `'paused'`      | `pauseWith('invalid_grant')`                          |
| `'kao_unauthorized'` | Kao 401 (bad bearer — wrong `KAO_TOKEN`)                        | `'error'`       | `recordFailedRun('kao_unauthorized')`, `errorCount++` |
| `'refresh_failed'`   | Kao unreachable, wrong host (404), 5xx, or misconfigured        | `'error'`       | `recordFailedRun('kao_unreachable')`, `errorCount++`  |

Kao-specific error classes (`KaoNoGrantError`, `KaoUnreachableError`, `KaoMisconfiguredError`) are kept internal to `kao-client.ts` and translated on the boundary so the ingest workers keep matching on the stable `OAuthError` taxonomy.

## `USER_EMAILS` allowlist

Comma-separated, lowercased, validated as `email` by zod. Used by both ingest workers for **skip-self on group threads** (drop `USER_EMAILS` from `to/cc/attendees` when ≥ 2 other recipients remain). The `from` role is preserved either way so outbound detection still works.

This is also the only piece of identity context the dashboard needs; it's read on the server side via `process.env.USER_EMAILS` in `apps/dashboard/src/lib/api.ts` to compute the inbound/outbound badge on a person's interaction list.

There is **no per-request user identification** — every `USER_EMAILS` address is implicitly "the user."

## Putting it together — typical flows

### First-time setup (operator)

1. Bring up Kao (see `kao/docs/configuration.md`). Note its public URL (`KAO_PUBLIC_URL`) and ingest bearer.
2. In `apps/api/.env`, set `KAO_URL=https://api.kao.localhost` and `KAO_TOKEN=<same bearer Kao expects>`. Restart the API.
3. Visit `https://kizuna.localhost` — no login.
4. Navigate to `/sync`, click "Connect Google" — `<form action={oauthStartUrl()} method="post">` posts to `${API_URL}/oauth/google/start`, which 303s to `${KAO_URL}/oauth/kizuna/start`.
5. Consent on Google. Land on Kao's success page. Kao persists the refresh token under the `kizuna` grant.
6. Click "Run sync now" — this hits `POST /sync/gmail/run` (and Calendar).

### Concierge / programmatic caller

1. POST directly to `/people`, `/interactions`, `/followups`, etc. No auth header. Source is auto-set to `'concierge'`.
2. List endpoints support cursor pagination via `?cursor=…`.

### Re-authorize after `invalid_grant`

1. Worker pauses; `SyncState.pausedAt` is set, `lastError = 'invalid_grant'`.
2. Operator visits `/sync`, clicks "Re-authorize" → re-runs the consent flow against Kao.
3. After Google's success page, `POST /sync/gmail/run` with `{ "force": true }` to clear the pause and run cleanly (or wait for the next scheduler tick).

If the operator wants to override the pause without re-granting (e.g. transient Kao outage): `POST /sync/gmail/run` with `{ "force": true }`. The route clears `pausedAt` and runs once.

## Threat model

What the localhost-only / no-API-auth posture does and doesn't defend against:

- **OS user boundary.** Anyone running as the operating-system user can reach the API and read/write the DB directly. That's the trust boundary; no application-level credential changes it.
- **Other dev tools on the same machine.** Could hit the API if pointed at it. Not defended against; not realistic for a personal dev box.
- **Browser-side attacks (DNS rebinding, malicious sites visited by the user).** Mitigated by HTTPS-on-localhost + browser CORS defaults; the API itself does not enable permissive CORS.
- **External OAuth callback collisions.** Defended in Kao by signed CSRF state bound to the grant name.
- **Refresh-token leakage via Kizuna filesystem snapshots / dotfile backups.** No longer a concern in Kizuna — there is no refresh token here to leak. The encrypted refresh token lives only in Kao's Mongo, under Kao's own threat model (`kao/docs/auth.md`).
- **`KAO_TOKEN` leakage.** Treat it like a write-equivalent secret to the Google account. If it leaks, anyone on localhost who can reach Kao can vend a Gmail-readonly + Calendar-readonly access token. Rotate by updating both `kao/apps/api/.env` and `kizuna/apps/api/.env` and restarting.

If any of these stop being true (the API gets exposed beyond localhost, the host gets shared, multi-user lands), reintroduce a bearer or scoped credential before exposure — do not assume localhost trust elsewhere.
