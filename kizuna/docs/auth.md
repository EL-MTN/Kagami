# Auth

Single-user-per-deployment, single-machine, localhost-only. The OS user boundary is the trust boundary; there is no API-level authentication. The resource routes accept any caller that can reach `https://api.kizuna.localhost`, and the dashboard at `https://kizuna.localhost` is open.

The only credentials Kizuna still owns are:

- The Google OAuth refresh token (encrypted at rest in Mongo).
- A process-local HMAC secret for OAuth-callback CSRF state (regenerated on every API restart; not persisted).
- `USER_EMAILS`, used only to identify which inbox addresses count as "self" during ingest.

## At a glance

| Layer                    | Mechanism                                                                                       | Source                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------- |
| resource routes (API)    | none — open at localhost                                                                        | —                                 |
| `/oauth/google/start`    | none — open at localhost                                                                        | `apps/api/src/routes/oauth.ts`    |
| `/oauth/google/callback` | HMAC-SHA-256 signed CSRF state token (10-min TTL, process-local secret); no credential on wire  | `apps/api/src/lib/oauth-state.ts` |
| `/oauth/google/status`   | none — open at localhost                                                                        | `apps/api/src/routes/oauth.ts`    |
| Refresh token at rest    | AES-256-GCM, key = `KIZUNA_OAUTH_ENCRYPTION_KEY` (base64 32 bytes), random 12-byte IV per write | `apps/api/src/lib/encryption.ts`  |
| Dashboard sessions       | none — dashboard is open at localhost                                                           | —                                 |
| Ingest "self" detection  | `USER_EMAILS` allowlist (lowercased, comma-separated)                                           | `apps/api/src/config.ts`          |

## OAuth grant flow

The OAuth callback is the only handler with a real adversary model: an external attacker could try to trick the user's browser into completing a consent flow that lands on Kizuna's callback. CSRF state defends against that, regardless of localhost.

### `GET /oauth/google/start`

Open. Validates `KIZUNA_OAUTH_ENCRYPTION_KEY` is set (otherwise `400` — no point starting a flow we couldn't persist), mints a signed state token via `makeState()`, builds the Google consent URL with `access_type: 'offline'`, `prompt: 'consent'`, `scope: gmail.readonly + calendar.readonly`, and the state, then `res.redirect(302, authUrl)`.

`prompt: 'consent'` is non-negotiable — Google only returns a `refresh_token` on a fresh consent. Without it, a re-grant might return only an access token, and the callback rejects with "Google did not return a refresh_token (re-consent with prompt=consent required)."

### `GET /oauth/google/callback`

The callback URL ends up in Google's redirect log and the user's browser history; we never put a credential on the wire here. The CSRF state token is verified via `verifyState()`.

State token format (`apps/api/src/lib/oauth-state.ts`):

```
<base64url(nonce ‖ ":" ‖ tsSeconds)>.<base64url(HMAC_SHA256(secret, payload))>
```

- Nonce: 16 random bytes.
- Timestamp: seconds since epoch.
- TTL: 10 minutes by default (`DEFAULT_TTL_SEC`).
- Secret: `randomBytes(32)` generated at module load. **Process-local; not persisted.** Restarting the API invalidates any in-flight consent flows; the user re-clicks "Authorize."

A forged or expired state → `401 unauthorized`. Missing `code` or `state` → `400 bad_request`. Google reporting one of the allowed OAuth error codes (`access_denied`, `server_error`, `invalid_scope`, `temporarily_unavailable`, `interaction_required`) → `400 bad_request` with that code surfaced. Unexpected `?error=` values are collapsed to a generic `google denied consent` response.

On success:

1. `client.getToken(code)` — exchanges the auth code for tokens.
2. If `tokens.refresh_token` is missing → `400 bad_request`.
3. `encrypt(refresh_token, KIZUNA_OAUTH_ENCRYPTION_KEY)` (AES-256-GCM).
4. `OAuthToken.findOneAndUpdate({ provider:'google' }, { $set: { refreshToken, scopes, grantedAt: now, deletedAt: null, source: 'concierge' } }, { upsert: true })`.
5. **Auto-resume paused workers**: `SyncState.updateMany({ pausedAt: { $ne: null } }, { $set: { pausedAt: null, lastError: null } })`. A re-grant after `invalid_grant` should "just work" without forcing the operator to also `POST /sync/.../run` with `force: true`.
6. `clearAccessTokenCache()` — drop the in-process access-token cache so the next worker run re-derives from the new refresh token.
7. Return a small inline HTML page: "Google access granted ✓".

### `GET /oauth/google/status`

Open. Returns one of:

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

The dashboard's `/sync` page polls this and decides whether to render "Connect Google" or "Re-authorize" + the worker control surfaces.

## Refresh-token encryption

`apps/api/src/lib/encryption.ts`:

```ts
ALGORITHM = 'aes-256-gcm'
IV_BYTES  = 12
TAG_BYTES = 16

encrypt(plaintext, envKey)
  → base64( iv (12) ‖ tag (16) ‖ ciphertext )

decrypt(envelope, envKey)
  → plaintext  (or throws on tampering / wrong key / undersized envelope)
```

The key is `KIZUNA_OAUTH_ENCRYPTION_KEY`, a base64 32-byte string. Generate once with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The zod config schema rejects a key that doesn't decode to exactly 32 bytes.

The IV is fresh per write, so encrypting the same refresh token twice yields different envelopes. The auth tag is verified on decrypt; tampering or a wrong key throws.

`KIZUNA_OAUTH_ENCRYPTION_KEY` is treated as required for any path that touches encrypted tokens (start, callback, sync runs). The route handlers fail with `400 bad_request` rather than running with cleartext storage.

If you rotate the key, all existing rows in `oauthtokens` become undecryptable — the operational fix is `OAuthToken.deleteMany({})` followed by re-running the OAuth flow.

## Access-token cache

`apps/api/src/lib/google-auth.ts`:

```ts
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

getAccessToken(config) =>
  cached if expiresAt > now + 30 s
  else: decrypt refresh, exchange via client.getAccessToken(), cache, return
```

The cache is process-local. In a multi-instance deploy, each worker would refresh independently; not a concern today (single-process).

`clearAccessTokenCache()` is called from the OAuth callback so a re-grant takes effect immediately rather than waiting for the cached token to expire.

`OAuthError` codes: `'no_grant'` (no row in `oauthtokens`), `'invalid_grant'` (Google rejected the refresh), `'refresh_failed'` (network / other). The sync workers map these to `result.status`:

| `OAuthError.code`  | `result.status` | Side effect on `SyncState`          |
| ------------------ | --------------- | ----------------------------------- |
| `'no_grant'`       | `'no_grant'`    | None — no row to mutate             |
| `'invalid_grant'`  | `'paused'`      | `pauseWith('invalid_grant')`        |
| `'refresh_failed'` | `'error'`       | `lastError` written, `errorCount++` |

## `USER_EMAILS` allowlist

Comma-separated, lowercased, validated as `email` by zod. Used by both ingest workers for **skip-self on group threads** (drop `USER_EMAILS` from `to/cc/attendees` when ≥ 2 other recipients remain). The `from` role is preserved either way so outbound detection still works.

This is also the only piece of identity context the dashboard needs; it's read on the server side via `process.env.USER_EMAILS` in `apps/dashboard/src/lib/api.ts` to compute the inbound/outbound badge on a person's interaction list.

There is **no per-request user identification** — every `USER_EMAILS` address is implicitly "the user."

## Putting it together — typical flows

### First-time setup (operator)

1. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` → `KIZUNA_OAUTH_ENCRYPTION_KEY`.
2. Set `USER_EMAILS=you@example.com`, `MONGODB_URI`, Google OAuth client creds. Restart the API.
3. Visit `https://kizuna.localhost` — no login.
4. Navigate to `/sync`, click "Connect Google" — `<a href={oauthStartUrl()}>` resolves to `${API_URL}/oauth/google/start`.
5. Consent on Google. Land on `/oauth/google/callback?...&state=...`. Refresh token is encrypted + stored.
6. Click "Run sync now" — this hits `POST /sync/gmail/run` (and Calendar).

### Concierge / programmatic caller

1. POST directly to `/people`, `/interactions`, `/followups`, etc. No auth header. Source is auto-set to `'concierge'`.
2. List endpoints support cursor pagination via `?cursor=…`.

### Re-authorize after `invalid_grant`

1. Worker pauses; `SyncState.pausedAt` is set, `lastError = 'invalid_grant'`.
2. Operator visits `/sync`, clicks "Re-authorize" → re-runs the consent flow.
3. The callback handler clears `pausedAt` on every paused row.
4. Next tick (or manual `POST /sync/.../run`) runs cleanly.

If the operator wants to override the pause without re-granting (e.g. transient outage): `POST /sync/gmail/run` with `{ "force": true }`. The route clears `pausedAt` and runs once.

## Threat model

What the localhost-only / no-API-auth posture does and doesn't defend against:

- **OS user boundary.** Anyone running as the operating-system user can reach the API and read/write the DB directly. That's the trust boundary; no application-level credential changes it.
- **Other dev tools on the same machine.** Could hit the API if pointed at it. Not defended against; not realistic for a personal dev box.
- **Browser-side attacks (DNS rebinding, malicious sites visited by the user).** Mitigated by HTTPS-on-localhost + browser CORS defaults; the API itself does not enable permissive CORS.
- **External OAuth callback collisions.** Defended by signed CSRF state on `/oauth/google/callback` (process-local HMAC secret).
- **Refresh-token leakage via filesystem snapshots / dotfile backups.** Defended by AES-256-GCM at rest under `KIZUNA_OAUTH_ENCRYPTION_KEY`. The encryption key still lives in env; this protects against DB-only compromise.

If any of these stop being true (the API gets exposed beyond localhost, the host gets shared, multi-user lands), reintroduce a bearer or scoped credential before exposure — do not assume localhost trust elsewhere.
