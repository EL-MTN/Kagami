# Configuration

API config lives at `apps/api/.env`; dashboard config at `apps/dashboard/.env`. Copy the corresponding `.env.example` files to start. Both are loaded by their respective frameworks (`dotenv/config` in `apps/api/src/main.ts`; Next.js loads its own).

## API (`apps/api/.env`)

Validated by zod at boot via `loadConfig()` (`apps/api/src/config.ts`). On parse failure the error message lists every issue and the process exits before binding the port.

```sh
# Required
KIZUNA_API_KEY=<≥ 16 chars; bearer token for /v1/* and seed for the dashboard cookie / OAuth state HMACs>
MONGO_URI=mongodb://127.0.0.1:27017/kizuna
USER_EMAILS=you@example.com               # comma-separated; lowercased; validated as email[]

# Required to actually start the OAuth flow / decrypt stored refresh tokens
KIZUNA_OAUTH_ENCRYPTION_KEY=<base64 of exactly 32 bytes>

# Required to run the OAuth flow at all
GOOGLE_OAUTH_CLIENT_ID=<from Google Cloud Console>
GOOGLE_OAUTH_CLIENT_SECRET=<from Google Cloud Console>
GOOGLE_OAUTH_REDIRECT_URI=https://api.kizuna.localhost/oauth/google/callback

# Optional
NEWSLETTER_DOMAIN_BLOCKLIST=mailchimp.com,substack.com    # comma-separated; lowercased
KIZUNA_GMAIL_BACKFILL_DAYS=30                              # default 30; range 1–365
KIZUNA_GCAL_BACKFILL_DAYS=60                               # default 60; range 1–365
KIZUNA_INGEST_INTERVAL_SEC=0                               # default 0 (scheduler disabled); 300 ≈ 5 min for typical dev
# PORT=3000                                                # standalone only; Portless injects this in dev
LOG_LEVEL=info                                             # pino level (`silent` in tests)
NODE_ENV=development                                       # enables pino-pretty in dev
```

Notes:

- `KIZUNA_API_KEY` is **also** the HMAC secret for the OAuth CSRF state token (`apps/api/src/lib/oauth-state.ts`) and for the dashboard's session cookie (`apps/dashboard/src/lib/session.ts`). Rotating it invalidates active dashboard sessions and any in-flight OAuth state — both are recoverable (re-login, re-start the OAuth flow).
- `KIZUNA_OAUTH_ENCRYPTION_KEY` is decoded from base64; the resulting buffer must be exactly 32 bytes. The schema rejects anything else with "must be a base64-encoded 32-byte key."
- `USER_EMAILS` controls the ingest workers' "self" detection — see [sync.md](sync.md) and [auth.md](auth.md). It is _not_ an authentication boundary.
- `KIZUNA_INGEST_INTERVAL_SEC=0` disables the in-process scheduler entirely. Manual triggers via `POST /v1/sync/{gmail,gcal}/run` work regardless. Set to `300` (5 min) for typical dev use.
- `PORT` only applies when running standalone. Under `npm run dev`, Portless picks an ephemeral port and routes `https://api.kizuna.localhost` to it. Prefer the Portless URL in local config and docs.

### Generating the encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the result into `KIZUNA_OAUTH_ENCRYPTION_KEY`. Don't reuse the API key for this — the encryption key is rotated independently if it ever leaks, and confusing the two would force rolling both at once.

If you rotate the encryption key, all rows in `oauthtokens` become undecryptable. The fix is `OAuthToken.deleteMany({})` followed by re-running the OAuth flow.

## Dashboard (`apps/dashboard/.env`)

```sh
KIZUNA_API_URL=https://api.kizuna.localhost
KIZUNA_API_KEY=<same key as the API>
USER_EMAILS=you@example.com
# Optional:
# KIZUNA_COOKIE_SECURE=true       # force Secure cookie even when NODE_ENV !== 'production'
```

The dashboard reads `process.env.KIZUNA_API_URL` / `KIZUNA_API_KEY` at module scope in `apps/dashboard/src/lib/api.ts`. Every server-component fetch passes `Authorization: Bearer ${KIZUNA_API_KEY}` and `cache: 'no-store'`. `USER_EMAILS` is read for the inbound/outbound classification on a person's interaction list.

The session-cookie HMAC is signed with `KIZUNA_API_KEY` — both apps must agree on the value, which is why the dashboard `.env.example` says "replace-with-the-same-key-as-the-api."

## Portless

Both apps register through `portless.json` at the repo root:

```json
{
  "apps": {
    "apps/dashboard": { "name": "kizuna" },
    "apps/api": { "name": "api.kizuna" }
  }
}
```

Portless picks an ephemeral port per app and routes:

- `https://kizuna.localhost` → dashboard
- `https://api.kizuna.localhost` → API

First run prompts once for sudo to install a local CA (HTTPS auto-trusted thereafter). A numeric `PORT=3000` override only matters when running the API standalone. Both `dev` scripts wrap their framework launcher with `portless run …`:

```jsonc
// apps/api/package.json
"dev": "portless run tsx watch src/main.ts"

// apps/dashboard/package.json
"dev": "portless run next dev"
```

## Common setups

### Single-machine dev with no Google ingest

```sh
KIZUNA_API_KEY=$(openssl rand -hex 24)
MONGO_URI=mongodb://127.0.0.1:27017/kizuna
USER_EMAILS=you@example.com
KIZUNA_INGEST_INTERVAL_SEC=0
# Skip GOOGLE_OAUTH_* and KIZUNA_OAUTH_ENCRYPTION_KEY — start/callback will reject, but the rest of /v1/* works.
```

You'll be able to use the concierge endpoints (`POST /v1/people`, etc.) and the dashboard's read-only views, but `/sync` will report "Google OAuth is not configured."

### Single-machine dev with Google ingest

```sh
KIZUNA_API_KEY=$(openssl rand -hex 24)
MONGO_URI=mongodb://127.0.0.1:27017/kizuna
USER_EMAILS=you@example.com
KIZUNA_OAUTH_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://api.kizuna.localhost/oauth/google/callback
KIZUNA_INGEST_INTERVAL_SEC=300
NEWSLETTER_DOMAIN_BLOCKLIST=mailchimp.com,substack.com,buttondown.email,reply.slack.com
```

Configure the OAuth client in Google Cloud Console as a "Web application" with the exact redirect URI above. The Portless URL `https://api.kizuna.localhost/oauth/google/callback` is what Google needs to see — both `localhost` and HTTPS are required.

### Bumping backfill horizons

```sh
KIZUNA_GMAIL_BACKFILL_DAYS=120
KIZUNA_GCAL_BACKFILL_DAYS=180
```

These only apply on the first run of each worker (the bootstrap path); incremental runs use cursors. Bump them, delete the relevant row in `syncstates`, and re-run the worker:

```bash
mongosh kizuna --eval "db.syncstates.deleteOne({ provider: 'gmail' })"
curl -XPOST -H "Authorization: Bearer $KIZUNA_API_KEY" \
     https://api.kizuna.localhost/v1/sync/gmail/run -H 'content-type: application/json' -d '{}'
```

Range is enforced by the schema: `1–365` days for both.

## MongoDB

Vanilla MongoDB ≥ 6 is sufficient. Kizuna uses no `$vectorSearch` or `$search` indexes; only btree + a couple of `$text` indexes for the people / interactions search bars. A typical dev setup:

```bash
docker run -d -p 27017:27017 --name mongo mongo:7
```

Or Homebrew:

```bash
brew install mongodb-community
brew services start mongodb-community
```

`mongoose.syncIndexes()` is called at boot for every registered model — partial-unique indexes (notably `interactions_sourceRef_unique`) need to be in place before the ingest scheduler can rely on them. If you're upgrading and an index shape changed, you may see a sync error logged at boot; fix is to drop the conflicting index in `mongosh` and let the next boot recreate it.

The test harness (`apps/api/test/helpers/harness.ts`) uses `testcontainers` to spin up a fresh `mongo:7` container per test run. See [testing.md](testing.md).
