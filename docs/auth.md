# Auth

Single-user-per-deployment. There is no user table — `KIZUNA_API_KEY` is the bearer credential for everything API-side, and `USER_EMAILS` is the address allowlist used by the ingest workers (which addresses to treat as "self" for skip-self semantics).

## At a glance

| Layer                     | Mechanism                                                                                              | Source                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `/v1/*` (API)             | `Authorization: Bearer <KIZUNA_API_KEY>` — `crypto.timingSafeEqual` compare                            | `apps/api/src/lib/auth.ts`            |
| `/oauth/google/start`     | Bearer header OR `?key=<KIZUNA_API_KEY>` (so a plain `<a href>` works from the dashboard)              | `apps/api/src/routes/oauth.ts`        |
| `/oauth/google/callback`  | HMAC-SHA-256 signed CSRF state token (10-min TTL, secret = `KIZUNA_API_KEY`); no API key on the wire   | `apps/api/src/lib/oauth-state.ts`     |
| `/oauth/google/status`    | Bearer header OR `?key=`                                                                               | `apps/api/src/routes/oauth.ts`        |
| Refresh token at rest     | AES-256-GCM, key = `KIZUNA_OAUTH_ENCRYPTION_KEY` (base64 32 bytes), random 12-byte IV per write        | `apps/api/src/lib/encryption.ts`      |
| Dashboard sessions        | HMAC-signed cookie (`kizuna_session`), secret = `KIZUNA_API_KEY`, 30-day TTL                            | `apps/dashboard/lib/session.ts`       |
| Ingest "self" detection   | `USER_EMAILS` allowlist (lowercased, comma-separated)                                                   | `apps/api/src/config.ts`              |

## Bearer auth on `/v1/*`

`apps/api/src/lib/auth.ts`:

```ts
export function bearerAuth(apiKey: string): RequestHandler {
  const expected = Buffer.from(apiKey, 'utf8');
  return (req, _res, next) => {
    const header = req.header('authorization');
    if (!header?.toLowerCase().startsWith('bearer ')) {
      next(errors.unauthorized('missing bearer token'));
      return;
    }
    const provided = Buffer.from(header.slice(7).trim(), 'utf8');
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      next(errors.unauthorized('invalid bearer token'));
      return;
    }
    req.auth = { source: 'concierge' };
    next();
  };
}
```

The middleware is mounted once for the entire `/v1/*` mount path. There's only one principal — the concierge — and it's reflected in `req.auth.source = 'concierge'` for any future per-source logic.

`KIZUNA_API_KEY` is required to be at least 16 characters by the zod config schema (`apps/api/src/config.ts`).

## OAuth grant flow

The OAuth handlers can't sit behind `bearerAuth` middleware because the browser lands on them from outside the dashboard. Instead, each handler does its own gating.

### `GET /oauth/google/start`

Reads the API key from `Authorization: Bearer …` *or* `?key=`. The `?key=` form exists so the dashboard can render a plain `<a href={oauthStartUrl()}>Connect Google</a>` instead of a JS-driven fetch + redirect.

Both paths use a constant-time compare. Then:

1. If `KIZUNA_OAUTH_ENCRYPTION_KEY` is unset → `400 bad_request` (no point starting a flow we couldn't persist).
2. Mint a signed state token: `makeState(KIZUNA_API_KEY)`.
3. Build the consent URL via `client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: gmail.readonly + calendar.readonly, state, include_granted_scopes: true })`.
4. `res.redirect(302, authUrl)`.

`prompt: 'consent'` is non-negotiable — Google only returns a `refresh_token` on a fresh consent, not on a re-grant of a previously-granted scope. Without it, a re-authorize that includes new scopes might return only an access token, and the callback rejects with "Google did not return a refresh_token (re-consent with prompt=consent required)."

### `GET /oauth/google/callback`

This handler **does not see the API key**. The callback URL ends up in Google's redirect log, the user's browser history, and possibly the network log of whatever client they were testing with — putting the bearer in there would be a leak. Instead, we trust a CSRF state token signed by the same secret (`KIZUNA_API_KEY`).

State token format (`apps/api/src/lib/oauth-state.ts`):

```
<base64url(nonce ‖ ":" ‖ tsSeconds)>.<base64url(HMAC_SHA256(secret, payload))>
```

- Nonce: 16 random bytes.
- Timestamp: seconds since epoch.
- TTL: 10 minutes by default (`DEFAULT_TTL_SEC`).
- Verification: split on `.`, base64url-decode payload + sig, recompute `HMAC_SHA256(secret, payload)`, `timingSafeEqual` against the supplied sig, then check the timestamp is within TTL.

A forged or expired state → `401 unauthorized`. Missing `code` or `state` → `400 bad_request`. Google reporting an error in `?error=access_denied` → `400 bad_request` with the error code surfaced.

On success:

1. `client.getToken(code)` — exchanges the auth code for tokens.
2. If `tokens.refresh_token` is missing → `400 bad_request` with the "re-consent with prompt=consent required" message.
3. `encrypt(refresh_token, KIZUNA_OAUTH_ENCRYPTION_KEY)` (AES-256-GCM, see below).
4. `OAuthToken.findOneAndUpdate({ provider:'google' }, { $set: { refreshToken, scopes, grantedAt: now, deletedAt: null, source: 'concierge' } }, { upsert: true })`.
5. **Auto-resume paused workers**: `SyncState.updateMany({ pausedAt: { $ne: null } }, { $set: { pausedAt: null, lastError: null } })`. A re-grant after `invalid_grant` should "just work" without forcing the operator to also `POST /v1/sync/.../run` with `force: true`.
6. `clearAccessTokenCache()` — drop the in-process access-token cache so the next worker run re-derives from the new refresh token.
7. Return a small inline HTML page: "Google access granted ✓".

### `GET /oauth/google/status`

Bearer-gated. Returns one of:

```json
{ "granted": false }
```

```json
{ "granted": true, "scopes": ["https://...gmail.readonly", "https://...calendar.readonly"], "grantedAt": "2026-04-01T..." }
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

| `OAuthError.code`  | `result.status` | Side effect on `SyncState`                 |
| ------------------ | --------------- | ------------------------------------------ |
| `'no_grant'`       | `'no_grant'`    | None — no row to mutate                    |
| `'invalid_grant'`  | `'paused'`      | `pauseWith('invalid_grant')`                |
| `'refresh_failed'` | `'error'`       | `lastError` written, `errorCount++`        |

## `USER_EMAILS` allowlist

Comma-separated, lowercased, validated as `email` by zod. Used by both ingest workers for **skip-self on group threads** (drop `USER_EMAILS` from `to/cc/attendees` when ≥ 2 other recipients remain). The `from` role is preserved either way so outbound detection still works.

This is also the only piece of identity context the dashboard needs; it's read on the server side via `process.env.USER_EMAILS` in `apps/dashboard/lib/api.ts` to compute the inbound/outbound badge on a person's interaction list.

There is **no per-request user identification** — the API accepts any caller with the right bearer token, and ingest treats every `USER_EMAILS` address as "the user."

## Dashboard sessions

`apps/dashboard/lib/session.ts` + `lib/auth-actions.ts`. The dashboard is a server-rendered Next.js app; every authed page is wrapped by `app/(app)/layout.tsx` which checks the cookie and redirects to `/login` on miss.

### Cookie format

```
<nonce>.<ts>.<hmac>
```

- Nonce: `randomBytes(16)` base64url
- Timestamp: `Date.now()` (milliseconds since epoch)
- HMAC: `HMAC_SHA256(secret = KIZUNA_API_KEY, payload = "<nonce>.<ts>")` base64url

Verification: split on `.` (must be exactly 3 parts), recompute the HMAC, `timingSafeEqual`, then check `Date.now() - Number(ts) < 30 days`.

The cookie name is `kizuna_session`. Cookie attributes:

- `httpOnly: true`
- `sameSite: 'lax'`
- `secure: NODE_ENV === 'production' || KIZUNA_COOKIE_SECURE === 'true'`
- `path: '/'`
- `maxAge: 30 days`

### Login

`POST /login` (server action `loginAction` in `lib/auth-actions.ts`):

1. Read `formData.get('key')`.
2. `checkApiKey(key)` — constant-time compare against `process.env.KIZUNA_API_KEY`.
3. If valid → set `kizuna_session` cookie + `redirect('/')`.
4. If not → `redirect('/login?error=1')`.

### Logout

`logoutAction`: `cookies().delete('kizuna_session')` + `redirect('/login')`.

There is no CSRF token on the login form — Next.js Server Actions emit one transparently, and the only authenticated state is the session cookie itself.

## Putting it together — typical flows

### First-time setup (operator)

1. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` → `KIZUNA_OAUTH_ENCRYPTION_KEY`.
2. Pick a long random `KIZUNA_API_KEY` (≥ 16 chars).
3. Set `USER_EMAILS=you@example.com`, `MONGO_URI`, Google OAuth client creds. Restart the API.
4. Visit `https://kizuna.localhost`, paste the API key on `/login`.
5. Navigate to `/sync`, click "Connect Google" — this is `<a href={oauthStartUrl()}>` which is `${API_URL}/oauth/google/start?key=${API_KEY}`.
6. Consent on Google. Land on `/oauth/google/callback?...&state=...`. Refresh token is encrypted + stored.
7. Click "Run sync now" — this hits `POST /v1/sync/gmail/run` (and Calendar) with the dashboard's API key.

### Concierge agent (programmatic caller)

1. Set `Authorization: Bearer <KIZUNA_API_KEY>` on every request.
2. POST to `/v1/people`, `/v1/interactions`, `/v1/followups`, etc. Source is auto-set to `'concierge'`.
3. List endpoints support cursor pagination via `?cursor=…`.
4. To know what endpoints exist: `GET /v1/_manifest` returns a JSON-Schema-shaped catalog.

### Re-authorize after `invalid_grant`

1. Worker pauses; `SyncState.pausedAt` is set, `lastError = 'invalid_grant'`.
2. Operator visits `/sync`, clicks "Re-authorize" → re-runs the consent flow.
3. The callback handler clears `pausedAt` on every paused row.
4. Next tick (or manual `POST /v1/sync/.../run`) runs cleanly.

If the operator wants to override the pause without re-granting (e.g. transient outage): `POST /v1/sync/gmail/run` with `{ "force": true }`. The route clears `pausedAt` and runs once.
