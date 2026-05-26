# Configuration

All env vars are validated by zod in `src/config.ts` at startup; a misconfig
throws with a per-field list before the server binds. `.env` lives at
`apps/api/.env` (`apps/api/.env.example` is the template).

| Var                          | Required | Default                     | Purpose                                                             |
| ---------------------------- | -------- | --------------------------- | ------------------------------------------------------------------- |
| `MONGODB_URI`                | yes      | —                           | Mongo connection (`mongodb://` or `mongodb+srv://`)                 |
| `KAO_DB_NAME`                | no       | `kao`                       | database name                                                       |
| `GOOGLE_OAUTH_CLIENT_ID`     | yes      | —                           | Google OAuth client id                                              |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes      | —                           | Google OAuth client secret                                          |
| `KAO_PUBLIC_URL`             | no       | `https://api.kao.localhost` | public origin; the callback is `${KAO_PUBLIC_URL}/oauth/callback`   |
| `KAO_DASHBOARD_URL`          | no       | `https://kao.localhost`     | where the OAuth callback's "back to grants" link points             |
| `KAO_ENCRYPTION_KEY`         | yes      | —                           | base64 **32-byte** key — refresh-token AES-256-GCM                  |
| `KAO_TOKEN`                  | yes      | —                           | bearer (≥16 chars) consumers present to `/grants/*`                 |
| `KAO_HOST`                   | no       | `127.0.0.1`                 | standalone bind host (Portless injects otherwise)                   |
| `PORT`                       | no       | `4040`                      | standalone bind port (Portless injects otherwise)                   |
| `LOG_LEVEL`                  | no       | `info`                      | pino level (`silent` in tests)                                      |
| `KANSOKU_URL`                | no       | —                           | observability shipper target (with the token below)                 |
| `KANSOKU_INGEST_TOKEN`       | no       | —                           | Kansoku HMAC; both must be set or the shipper stays off (fail-open) |

Unlike Kizuna (where Google OAuth is optional), Kao's Google creds, encryption
key, and bearer are **required** — the service has no function without them.

## Generating the secrets

```bash
# KAO_ENCRYPTION_KEY (base64 32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# KAO_TOKEN (hex, ≥16 chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Google Cloud OAuth client

One **Web application** OAuth client for the whole workspace. Register exactly
one authorized redirect URI:

```
https://api.kao.localhost/oauth/callback        # (or your KAO_PUBLIC_URL + /oauth/callback)
```

Only one URI is needed because every grant flows through the single
`/oauth/callback`; the grant being authorized travels in signed state. Enable
the Gmail API and Google Calendar API on the project (the union of all grant
scopes).

> Migration note: both consumers are migrated. Kokoro reads short-lived
> access tokens from `${KAO_URL}/grants/kokoro/token` (its
> `GOOGLE_OAUTH_REFRESH_TOKEN` is gone). Kizuna reads from
> `${KAO_URL}/grants/kizuna/token` (its `encryption.ts`,
> `oauth-state.ts`, `OAuthToken` Mongoose model, and `google-auth-library`
> dep are gone). No service in Kagami owns its own Google refresh token
> anymore.

## Portless

`kao/portless.json` registers `apps/api` as `api.kao` →
`https://api.kao.localhost` **and** `apps/dashboard` as `kao` →
`https://kao.localhost`. `npm run kao:dev` (or `./dev-all.sh --only kao`)
launches both under Portless; `PORT`/`KAO_HOST` only matter running outside
Portless.

## Dashboard configuration (`apps/dashboard/.env`)

The dashboard is a separate Next.js process with its own `.env`. Two vars,
both server-side:

| Var           | Required | Default                     | Purpose                                                           |
| ------------- | -------- | --------------------------- | ----------------------------------------------------------------- |
| `KAO_API_URL` | no       | `https://api.kao.localhost` | Where the Next.js server reaches the Kao API                      |
| `KAO_TOKEN`   | yes      | —                           | Bearer presented to `/grants/*`; must match the API's `KAO_TOKEN` |

`apps/dashboard/.env.example` is the template. The bearer is read at request
time from the dashboard's server runtime and injected into every `/grants/*`
call — it **never reaches the browser**. Server Components fetch reads;
Server Actions handle Revoke + Token Probe.

## Production

`npm run build` (`tsc -p tsconfig.build.json` → `dist/`) for the API, then
`npm start` (`node dist/main.js`) — the workspace's compiled-output
convention. The compiled binary fails fast with a structured fatal log if env
is invalid. The dashboard builds via `next build` and runs with `next start`.
