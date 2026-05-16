# Kansoku — Configuration

All knobs are env-driven. Template: [`apps/api/.env.example`](../apps/api/.env.example)
and [`apps/dashboard/.env.example`](../apps/dashboard/.env.example).

## API (`apps/api/.env`)

| Var                         | Default                                                   | Purpose                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KANSOKU_HOST`              | `127.0.0.1`                                               | Standalone fallback bind address (Portless injects `PORT` and proxies the named HTTPS URL).                                                                                                                                                                                                                                                |
| `PORT`                      | `7779`                                                    | Standalone fallback port; ignored under Portless.                                                                                                                                                                                                                                                                                          |
| `LOG_LEVEL`                 | `info`                                                    | Pino log level.                                                                                                                                                                                                                                                                                                                            |
| `LOG_PRETTY`                | _(unset → TTY-detect)_                                    | `@kagami/logger` console gate (every service, Kansoku included). `1`/`true` forces human-pretty, `0`/`false` forces raw NDJSON; unset → pretty only when stdout is an interactive TTY. Replaces the old `NODE_ENV`-based gate so deployed/staging boxes emit JSON to collectors.                                                           |
| `LOG_SAMPLE_RATE`           | `1`                                                       | `@kagami/logger` head-sampling rate in [0,1] (every service). Fraction of fresh root traces kept; the rest are sampled out and their below-`warn` lines aren't shipped to Kansoku (`warn`/`error`/`fatal` always ship). `1` = keep everything (default); unparseable → fail-open to `1`. Per-trace decision, propagated via `traceparent`. |
| `MONGODB_URI`               | `mongodb://127.0.0.1:27017/kansoku?directConnection=true` | MongoDB connection. The DB name lives in the URI path (falls back to `kansoku` if the URI's default DB is `test`). Time-series collections require Mongo 5.0+.                                                                                                                                                                             |
| `KANSOKU_INGEST_TOKEN`      | _(unset → fail-closed)_                                   | Shared HMAC token presented by sibling shippers in `x-kansoku-auth`. **Required** for ingest to work — when unset, `POST /v1/logs` returns 503. Generate with `openssl rand -hex 32` and copy the same value into each sibling's `.env`.                                                                                                   |
| `KANSOKU_LOGS_TTL_DAYS`     | `30` (cap 365)                                            | Time-series `logs` collection TTL. Reconciled via `collMod` on every startup — change + restart to dial. Strict integer parse; `"30days"` is rejected with a warn.                                                                                                                                                                         |
| `KANSOKU_ERRORS_TTL_DAYS`   | `90` (cap 365)                                            | `errors` registry retention, as a TTL index on `errors_last_seen`. A fingerprint that stops recurring ages out this many days after its last hit; an active one keeps refreshing and never expires. Same strict-int parse + reconcile-on-restart posture as the logs TTL.                                                                  |
| `KANSOKU_MAX_META_COMBOS`   | `1000`                                                    | Distinct `{service,component,env,level}` budget guarding time-series bucket cardinality. Tuples seen under budget pass through; once exhausted, new tuples collapse into one sentinel bucket (level kept). Floor 1; strict-int parse with a warn fallback. Raise only if you legitimately run that many service/component combos.          |
| `KANSOKU_ALERT_WEBHOOK_URL` | _(unset)_                                                 | Optional. Fire-and-forget POST when a brand-new error fingerprint shows up. Discord / Slack–shaped JSON: `{ kind, fingerprint, service, component, name?, message, firstSeen, traceId? }`. 5 s timeout; failure swallowed.                                                                                                                 |

## Dashboard (`apps/dashboard/.env`)

| Var               | Default                         | Purpose                                                                                                                            |
| ----------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `KANSOKU_API_URL` | `https://api.kansoku.localhost` | API base. Must be reachable from both the Next.js server _and_ the user's browser (the live-tail `EventSource` runs browser-side). |

## Sibling services

Every sibling that ships logs reads two vars:

| Var                    | Notes                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `KANSOKU_URL`          | Defaults to `https://api.kansoku.localhost`.                                                                   |
| `KANSOKU_INGEST_TOKEN` | Must match Kansoku's value; either-missing leaves the logger stdout-only (graceful in dev and during outages). |

Logger wrappers normalize empty strings to "missing" so a `KANSOKU_URL=`
(no value) typo doesn't silently disable the shipper.

## Token rotation

There is no live token rotation primitive. To rotate:

1. Generate a new token: `openssl rand -hex 32`
2. Update `KANSOKU_INGEST_TOKEN` in Kansoku's `.env`
3. Update `KANSOKU_INGEST_TOKEN` in every sibling's `.env`
4. Restart all services (in any order — `dev-all.sh` boots them in parallel)

During the gap between (2) and (4) the shippers may briefly fail-open
into their local ring buffers — by design.

## Token / read-route auth model

`POST /v1/logs` is the only token-gated endpoint. All read routes
(`/v1/logs`, `/v1/tail`, `/v1/traces/:id`, `/v1/errors`, `/v1/services`)
are unauthenticated, matching the single-user-localhost convention from
the sibling APIs. The OS user is the trust boundary; Portless binds
loopback only.

## Mongo retention

The `logs` time-series collection has a TTL set via `expireAfterSeconds`
on creation, reconciled on every startup via `collMod`. The `errors`
registry has a TTL too — a single-field TTL index on `errors_last_seen`
(`KANSOKU_ERRORS_TTL_DAYS`, default 90). It expires per row off `lastSeen`,
so only fingerprints that have gone quiet age out; `recentTraceIds` stays
bounded per row regardless. `ensureIndexes` creates the TTL index, or
reconciles a pre-existing non-TTL `errors_last_seen` in place via
`collMod` (IndexOptionsConflict path).

Older `mongodb-memory-server` builds reject `collMod` on time-series
collections with code 167; the reconciler logs a warning and leaves the
existing TTL in place.
