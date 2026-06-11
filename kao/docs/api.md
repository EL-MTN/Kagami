# API

Base URL: `https://api.kao.localhost` (Portless) — standalone fallback
`http://127.0.0.1:4040`.

Error envelope (all errors): `{ "error": { "code": string, "message": string, "details"?: unknown } }`.

## Grant registry

`src/grant-registry.ts` is the single source of truth for which grants exist
and what each is consented for. Adding a consumer is a one-line, reviewable
change here.

| Grant    | Scopes                                                  |
| -------- | ------------------------------------------------------- |
| `kizuna` | `gmail.readonly`, `calendar.readonly`                   |
| `kokoro` | `gmail.readonly`, `gmail.send`, `calendar` (read/write) |

These mirror today's independent implementations exactly, so a consumer
migrating to Kao keeps identical capability — no scope drift.

## Open endpoints (operator browser; not bearer-gated)

### `GET /health`

`200 { "status": "ok", "service": "kao-api" }`. Liveness.

### `GET /`

Inline-HTML operator page: every registry grant with granted/not-granted
status and a Connect / Re-consent link. Holds no secret. Fallback for when
the Next.js dashboard at `https://kao.localhost` isn't running (or hasn't
been spun up yet on a fresh checkout).

### `GET /oauth/:grant/start`

`:grant` must be a registry name (else `404`). Mints a grant-bound CSRF state
and `302`-redirects to Google's consent screen with `access_type=offline`,
`prompt=consent`, and the **registry** scope set for that grant (never taken
from the request). Open at localhost — the defense is the signed state.

### `GET /oauth/callback`

Single shared callback. Recovers the grant from the signed state.

- missing `code`/`state`, or `?error=` → `400 bad_request`
- forged / expired state → `401 unauthorized`
- Google returned no `refresh_token` → `400 bad_request` (re-consent with
  `prompt=consent` required)
- success → AES-256-GCM-encrypt the refresh token, upsert the grant, clear
  that grant's access-token cache, return an inline success page that links
  the operator back to `${KAO_DASHBOARD_URL}/grants/:n` (per-grant detail)
  and `${KAO_DASHBOARD_URL}/` (all grants) so the consent round-trip ends
  on the dashboard rather than the API's inline `GET /` home.

`prompt=consent` is non-negotiable: Google only returns a `refresh_token` on
a fresh consent.

## Bearer-gated endpoints (`/grants/*`)

Every request needs `Authorization: Bearer ${KAO_TOKEN}`. Missing/malformed
or wrong token → `401 unauthorized`. This surface is **not** open at
localhost — see `auth.md`.

### `GET /grants`

`200 { "grants": [ { name, scopes, granted, grantedAt, revokedAt } ] }` for
every registry grant (registry-driven — a never-consented grant still appears
with `granted: false`).

### `GET /grants/:grant`

Single status (same shape, unwrapped). Unknown grant → `404`.

### `GET /grants/:grant/token` — the hot path consumers will call

- unknown grant → `404 not_found`
- no token on file / revoked → `409 conflict`, `details: { code: "no_grant" }`
- stored token undecryptable (rotated/corrupt `KAO_ENCRYPTION_KEY`) → `409 conflict`, `details: { code: "decrypt_failed" }` (re-consent required)
- Google rejected the refresh → `409 conflict`, `details: { code: "invalid_grant" }`
  (consumer should surface "re-consent at Kao")
- transient refresh failure → `502 bad_gateway`
- success → `200 { accessToken, expiresAt, scopes }`

`expiresAt` is epoch ms. Kao caches per grant with a 30 s safety buffer, so
hot callers don't each trigger a Google refresh.

### `DELETE /grants/:grant`

Best-effort Google revocation, then soft-revoke locally (token nulled,
`revokedAt` set, row kept), clear the cache. Idempotent — `200 { revoked: true, grant }`
even if nothing was on file.

## Consumer contract

A consumer replaces its own refresh-token storage + refresh logic with:

```
GET ${KAO_URL}/grants/<self>/token   Authorization: Bearer ${KAO_TOKEN}
→ { accessToken, expiresAt, scopes }
```

and calls Google with `accessToken` until `expiresAt`, re-fetching after. On
`409 invalid_grant` it must stop and prompt the operator to re-consent at
`${KAO_URL}/oauth/<self>/start`.

**Live consumers:**

- **Kokoro** (`kokoro/apps/bot/src/services/kao-client.ts`) — vends the
  `kokoro` grant. Thin per-grant in-process cache (30 s buffer matching
  Kao's), structured `KaoNoGrantError` / `KaoUnreachableError` /
  `KaoMisconfiguredError` taxonomy at the call site, integrated into the
  bot's existing `getGoogleAuth()` so Gmail/Calendar service modules use
  the vended token transparently.
- **Kizuna** (`kizuna/apps/api/src/lib/kao-client.ts`) — vends the `kizuna`
  grant. Replaced Kizuna's old encrypted-Mongo refresh-token storage and
  Kizuna-hosted Google web flow with this contract; reshapes
  `${KAO_URL}/grants/kizuna` into the legacy `OAuthStatus` envelope and
  self-heals on a Google 401 by re-vending with `?force=1`. The
  Gmail/Calendar ingest workers consume the vended token transparently.
