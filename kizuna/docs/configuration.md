# Configuration

API config lives at `apps/api/.env`; dashboard config at `apps/dashboard/.env`. Copy the corresponding `.env.example` files to start. Both are loaded by their respective frameworks (`dotenv/config` in `apps/api/src/main.ts`; Next.js loads its own).

## API (`apps/api/.env`)

Validated by zod at boot via `loadConfig()` (`apps/api/src/config.ts`). On parse failure the error message lists every issue and the process exits before binding the port.

```sh
# Required
MONGODB_URI=mongodb://127.0.0.1:27017/kizuna
USER_EMAILS=you@example.com               # comma-separated; lowercased; validated as email[]

# Required to enable Gmail / Calendar ingest (Google access is vended by Kao)
KAO_URL=https://api.kao.localhost         # default; the Kao identity service in the same workspace
KAO_TOKEN=<same value as Kao's KAO_TOKEN> # shared bearer; min 16 chars

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

- The API has no bearer/auth env var on its own resource routes — single-user localhost, OS user is the trust boundary. See [auth.md](auth.md) for the threat model.
- `KAO_URL` has a sensible localhost default; `KAO_TOKEN` is a secret with no default. Blank values are treated as unset (so `KAO_URL=` falls back to the default; `KAO_TOKEN=` leaves it undefined). Without `KAO_TOKEN`, ingest runs surface a `refresh_failed` error and no HTTP call is made — the operator hasn't completed setup.
- `USER_EMAILS` controls the ingest workers' "self" detection — see [sync.md](sync.md) and [auth.md](auth.md). It is _not_ an authentication boundary.
- `KIZUNA_INGEST_INTERVAL_SEC=0` disables the in-process scheduler entirely. Manual triggers via `POST /sync/{gmail,gcal}/run` work regardless. Set to `300` (5 min) for typical dev use.
- `KIZUNA_HOST` and `PORT` only apply when running standalone. Under `npm run dev`, Portless picks an ephemeral port and routes `https://api.kizuna.localhost` to it. Prefer the Portless URL in local config and docs.

### Granting Google access via Kao

Consent for the `kizuna` grant (`gmail.readonly` + `calendar.readonly`) lives in Kao. After setting `KAO_URL` + `KAO_TOKEN`, visit `${KAO_URL}/oauth/kizuna/start` (or click "Grant / re-consent in Kao" on the Kizuna dashboard's `/sync` page). Kao stores the encrypted refresh token under the `kizuna` grant in its own DB; Kizuna never sees it. See [`kao/CLAUDE.md`](../../kao/CLAUDE.md) and [`kao/docs`](../../kao/docs/) for Kao's contract and grant registry.

## Dashboard (`apps/dashboard/.env`)

```sh
KIZUNA_API_URL=https://api.kizuna.localhost
USER_EMAILS=you@example.com
KAO_URL=https://api.kao.localhost   # used by /sync to link out to Kao for consent
```

The dashboard reads `process.env.KIZUNA_API_URL` at module scope in `apps/dashboard/src/lib/api.ts`. Every server-component fetch sends no auth header (the API is open at single-user localhost) and uses `cache: 'no-store'`. `USER_EMAILS` is read for the inbound/outbound classification on a person's interaction list. `KAO_URL` is used purely to build the `${KAO_URL}/oauth/kizuna/start` link on the `/sync` page — no token is needed at the dashboard layer.

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
# Skip KAO_TOKEN — sync runs will record `refresh_failed`, but the rest of the resource API works.
```

You'll be able to use the concierge endpoints (`POST /people`, etc.) and the dashboard's read-only views; `/sync` will surface the `refresh_failed` line on each worker until Kao is wired up.

### Single-machine dev with Google ingest

```sh
MONGODB_URI=mongodb://127.0.0.1:27017/kizuna
USER_EMAILS=you@example.com
KAO_URL=https://api.kao.localhost
KAO_TOKEN=<same value as Kao's KAO_TOKEN>
KIZUNA_INGEST_INTERVAL_SEC=300
NEWSLETTER_DOMAIN_BLOCKLIST=mailchimp.com,substack.com,buttondown.email,reply.slack.com
```

Stand up Kao (`kao/CLAUDE.md`) first — its env owns the Google OAuth client creds, `KAO_ENCRYPTION_KEY`, and `KAO_TOKEN`. The same `KAO_TOKEN` value goes in Kizuna's `.env`. Then visit `${KAO_URL}/oauth/kizuna/start` (or use the dashboard button) to consent.

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
