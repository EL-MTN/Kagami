# Configuration

API config lives at `apps/api/.env`; dashboard config at `apps/dashboard/.env`. Copy the corresponding `.env.example` files to start. Both are loaded by their respective frameworks (`dotenv/config` in `apps/api/src/main.ts`; Next.js loads its own).

## API (`apps/api/.env`)

Validated by zod at boot via `loadConfig()` (`apps/api/src/config.ts`). On parse failure the error message lists every issue and the process exits before binding the port.

```sh
# Required
MONGODB_URI=mongodb://127.0.0.1:27017/kizuna
USER_EMAILS=you@example.com               # comma-separated; lowercased; validated as email[]

# Required to run the Gmail / Calendar ingest. Both vars must be set together;
# Kizuna fetches Google access tokens from Kao at runtime. Kao itself stores
# the encrypted refresh token and hosts the consent flow. See kao/docs.
KAO_URL=https://api.kao.localhost
KAO_TOKEN=<same bearer Kao expects (KAO_TOKEN in kao/apps/api/.env)>

# Optional
NEWSLETTER_DOMAIN_BLOCKLIST=mailchimp.com,substack.com    # comma-separated; lowercased
KIZUNA_GMAIL_BACKFILL_DAYS=30                              # default 30; range 1–365
KIZUNA_GCAL_BACKFILL_DAYS=60                               # default 60; range 1–365
KIZUNA_INGEST_INTERVAL_SEC=0                               # default 0 (scheduler disabled); 300 ≈ 5 min for typical dev
KIZUNA_HOST=127.0.0.1                                      # standalone bind host; Portless uses its proxy
# PORT=3000                                                # standalone only; Portless injects this in dev
LOG_LEVEL=info                                             # pino level (`silent` in tests)
NODE_ENV=development                                       # enables pino-pretty in dev
```

Notes:

- The API has no bearer/auth env var of its own. The OAuth CSRF state and the Google refresh token both live in Kao now (`kao/apps/api/src/lib/oauth-state.ts`, `kao/apps/api/src/lib/encryption.ts`). See [auth.md](auth.md) for the threat model.
- `KAO_URL` and `KAO_TOKEN` must be set as a pair — the zod schema rejects half-configured Kao with "KAO_URL and KAO_TOKEN must be set together." Blank values are treated as unset, so copying `.env.example` as-is keeps Google ingest disabled until both are provided.
- `USER_EMAILS` controls the ingest workers' "self" detection — see [sync.md](sync.md) and [auth.md](auth.md). It is _not_ an authentication boundary.
- `KIZUNA_INGEST_INTERVAL_SEC=0` disables the in-process scheduler entirely. Manual triggers via `POST /sync/{gmail,gcal}/run` work regardless. Set to `300` (5 min) for typical dev use.
- `KIZUNA_HOST` and `PORT` only apply when running standalone. Under `npm run dev`, Portless picks an ephemeral port and routes `https://api.kizuna.localhost` to it. Prefer the Portless URL in local config and docs.

### Where the OAuth client lives now

The Google Cloud OAuth client is registered for **Kao**, not Kizuna. The single redirect URI registered in Google Cloud is `${KAO_PUBLIC_URL}/oauth/callback`. Kizuna's `POST /oauth/google/start` is a 303 to `${KAO_URL}/oauth/kizuna/start` (POST so browser preloaders / `<img src>` tags can't trigger the state mutation; Origin-checked); the `kizuna` grant in Kao's registry is consented for read-only Gmail + Calendar. See `kao/docs/configuration.md` for the Kao setup (Google client ID/secret, encryption key, public URL).

## Dashboard (`apps/dashboard/.env`)

```sh
KIZUNA_API_URL=https://api.kizuna.localhost
USER_EMAILS=you@example.com
```

The dashboard reads `process.env.KIZUNA_API_URL` at module scope in `apps/dashboard/src/lib/api.ts`. Every server-component fetch sends no auth header (the API is open at single-user localhost) and uses `cache: 'no-store'`. `USER_EMAILS` is read for the inbound/outbound classification on a person's interaction list.

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
MONGODB_URI=mongodb://127.0.0.1:27017/kizuna
USER_EMAILS=you@example.com
KIZUNA_INGEST_INTERVAL_SEC=0
# Skip KAO_URL/KAO_TOKEN — /sync/* will return 400 and the dashboard's
# "Connect Google" button is disabled, but the rest of the resource API works.
```

You'll be able to use the concierge endpoints (`POST /people`, etc.) and the dashboard's read-only views, but `/sync` will report "Kao is not configured."

### Single-machine dev with Google ingest

```sh
MONGODB_URI=mongodb://127.0.0.1:27017/kizuna
USER_EMAILS=you@example.com
KAO_URL=https://api.kao.localhost
KAO_TOKEN=<same bearer Kao expects>
KIZUNA_INGEST_INTERVAL_SEC=300
NEWSLETTER_DOMAIN_BLOCKLIST=mailchimp.com,substack.com,buttondown.email,reply.slack.com
```

Bring up Kao alongside Kizuna (`npm run kao:dev` or `./dev-all.sh`). Then in the dashboard click "Connect Google" — the form POSTs to `${API_URL}/oauth/google/start`, which 303s to `${KAO_URL}/oauth/kizuna/start` and Kao runs the consent flow. If you run the dashboard on a non-default origin (renamed Portless host, bare-port debug), extend the allowlist via `KIZUNA_DASHBOARD_ORIGIN=<your-origin>` in `apps/api/.env`.

### Bumping backfill horizons

```sh
KIZUNA_GMAIL_BACKFILL_DAYS=120
KIZUNA_GCAL_BACKFILL_DAYS=180
```

These only apply on the first run of each worker (the bootstrap path); incremental runs use cursors. Bump them, delete the relevant row in `syncstates`, and re-run the worker:

```bash
mongosh kizuna --eval "db.syncstates.deleteOne({ provider: 'gmail' })"
curl -XPOST https://api.kizuna.localhost/sync/gmail/run \
     -H 'content-type: application/json' -d '{}'
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

The test harness (`apps/api/tests/helpers/harness.ts`) uses `mongodb-memory-server` — one in-process `mongod` is booted by Vitest's `globalSetup` and shared across files, with each `startHarness()` call getting its own database name on that instance. No Docker required. See [testing.md](testing.md).
