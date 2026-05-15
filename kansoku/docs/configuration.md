# Kansoku — Configuration

All knobs are env-driven. Template: [`apps/api/.env.example`](../apps/api/.env.example)
and [`apps/dashboard/.env.example`](../apps/dashboard/.env.example).

## API (`apps/api/.env`)

| Var                         | Default                                            | Purpose                                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KANSOKU_HOST`              | `127.0.0.1`                                        | Standalone fallback bind address (Portless injects `PORT` and proxies the named HTTPS URL).                                                                                                                                              |
| `PORT`                      | `7779`                                             | Standalone fallback port; ignored under Portless.                                                                                                                                                                                        |
| `LOG_LEVEL`                 | `info`                                             | Pino log level.                                                                                                                                                                                                                          |
| `KANSOKU_MONGO_URI`         | `mongodb://127.0.0.1:27017/?directConnection=true` | MongoDB connection. Time-series collections require Mongo 5.0+.                                                                                                                                                                          |
| `KANSOKU_MONGO_DB`          | `kansoku`                                          | Database name.                                                                                                                                                                                                                           |
| `KANSOKU_INGEST_TOKEN`      | _(unset → fail-closed)_                            | Shared HMAC token presented by sibling shippers in `x-kansoku-auth`. **Required** for ingest to work — when unset, `POST /v1/logs` returns 503. Generate with `openssl rand -hex 32` and copy the same value into each sibling's `.env`. |
| `KANSOKU_LOGS_TTL_DAYS`     | `30` (cap 365)                                     | Time-series `logs` collection TTL. Reconciled via `collMod` on every startup — change + restart to dial. Strict integer parse; `"30days"` is rejected with a warn.                                                                       |
| `KANSOKU_ALERT_WEBHOOK_URL` | _(unset)_                                          | Optional. Fire-and-forget POST when a brand-new error fingerprint shows up. Discord / Slack–shaped JSON: `{ kind, fingerprint, service, component, name?, message, firstSeen, traceId? }`. 5 s timeout; failure swallowed.               |

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
registry has no TTL — distinct fingerprints accumulate forever (with
bounded `recentTraceIds` per row).

Older `mongodb-memory-server` builds reject `collMod` on time-series
collections with code 167; the reconciler logs a warning and leaves the
existing TTL in place.
