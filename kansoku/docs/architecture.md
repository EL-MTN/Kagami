# Kansoku — Architecture

Kansoku (観測, "observation") is the Kagami workspace's centralized observability service: structured logs, distributed traces, error fingerprints, and metrics in one place, fed by every sibling service over HTTP.

## Why it exists

Until Kansoku, every service in Kagami logged to stdout and that was it — no aggregation, no cross-service correlation, no error grouping, no historical search. Three services × ~339 log call sites across the workspace, all evaporating the moment a terminal scrolled.

Kansoku consolidates those streams:

- **Logs** — every `logger.*` call from Kioku/Kokoro/Kizuna ships to Kansoku via a Pino transport added to `@kagami/logger`.
- **Traces** — incoming HTTP requests get a W3C `traceparent`-compatible context; outgoing `fetch` calls in Kokoro propagate it to Kioku/Kizuna; logs auto-include `traceId`/`spanId` via `AsyncLocalStorage`.
- **Errors** — `level >= error` events are fingerprinted (hash of `error.name + error.message + top stack frame`) and rolled up into a per-fingerprint document with `firstSeen`, `lastSeen`, `count`, and a bounded list of recent trace IDs.
- **Metrics** — derived from logs in Phase 1 (counts, error rates, `durationMs` percentiles), with an explicit `metric(name, value, tags?)` API added in Phase 6 when log-derived isn't enough.

## Posture

Kansoku is **push-only-in**. It never initiates outbound calls to siblings. Every shipper at every call site is **fail-open** — a network error talking to Kansoku must never wedge a sibling service. The Pino transport keeps a bounded in-memory ring buffer (~5 minutes); on overflow it drops oldest and increments a local counter that gets shipped on next successful flush.

## Data model

MongoDB is the only store. The existing workspace Mongo instance is reused with a dedicated database (`kansoku`).

| Collection | Type                                            | Purpose                                                                 | Retention |
| ---------- | ----------------------------------------------- | ----------------------------------------------------------------------- | --------- |
| `logs`     | time-series (`timeField: ts`, `metaField: meta`)| Every shipped log line. `meta: { service, component, env, level }`.     | 30 days   |
| `metrics`  | time-series (`timeField: ts`, `metaField: meta`)| Pushed metrics. `meta: { service, name, tags }`. Phase 6+.              | 30 days   |
| `errors`   | regular, `_id = fingerprint`                    | One doc per unique error. Holds `count`, sample message, sample stack, `firstSeen`, `lastSeen`, last-N trace IDs. | indefinite |
| `spans`    | time-series (optional)                          | Derived from `logs` initially; promoted to a first-class collection if log-derived traces get too expensive to query. | 30 days   |

Indexes (Phase 1):

- `logs`: `{ "meta.service": 1, ts: -1 }`, `{ traceId: 1 }`, `{ "meta.level": 1, ts: -1 }`
- `errors`: `{ lastSeen: -1 }`, `{ service: 1, lastSeen: -1 }`

## Ingest path (Phase 1+)

```
service code
  └─ logger.info({ ... }, "msg")
        └─ pino multi-stream:
              ├─ stdout (unchanged)
              └─ @kagami/logger/transport-kansoku
                    └─ buffer (250ms or 50 events, whichever first)
                          └─ POST https://api.kansoku.localhost/v1/logs
                                ├─ HMAC auth via KANSOKU_INGEST_TOKEN
                                ├─ Zod-validate envelope
                                ├─ enqueue → bulk-write to logs (time-series)
                                ├─ if level >= 50 → upsert errors by fingerprint
                                └─ fanout to /v1/tail SSE subscribers
                          └─ 202 Accepted
```

## Authentication

Phase 1 uses a shared HMAC token (`KANSOKU_INGEST_TOKEN`) carried as a request header (`x-kansoku-auth`). One token per Kagami install — rotation is a manual env change. Personal scale; no per-service identity needed yet.

## Dashboard surfaces

| Page             | Purpose                                                    | Backed by              |
| ---------------- | ---------------------------------------------------------- | ---------------------- |
| `/tail`          | Live stream, filter by service / component / level         | SSE `/v1/tail`         |
| `/search`        | Historical log search, time-range + structured-field filters | `/v1/logs?q=…`       |
| `/traces/:id`    | Single-trace waterfall, log timeline                       | `/v1/traces/:id`       |
| `/errors`        | Grouped by fingerprint, sortable by `lastSeen` / `count`   | `/v1/errors`           |
| `/services`      | Per-service log volume sparklines, error rate, last-seen   | aggregations           |

## Phased delivery

| Phase | Scope                                                                                                         | Status        |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------------- |
| 0     | Scaffold (`kansoku/{apps,packages,docs}`, Portless URLs, workspace globs, `/health`)                          | **this PR**   |
| 1     | Mongo time-series setup, `/v1/logs` ingest, Zod envelope, `@kagami/logger/transport-kansoku`, wire one service end-to-end | next          |
| 2     | Dashboard `/tail` (SSE) and `/search`                                                                         |               |
| 3     | Trace context (ALS + middleware + `tracedFetch`), `/traces/:id` view                                          |               |
| 4     | Error fingerprinting + `/errors` page                                                                         |               |
| 5     | Roll out shipper to all three services; collapse any divergence                                               |               |
| 6     | Derived metrics + `/services` dashboard                                                                       |               |
| 7     | TTL policies, retention dial-in, optional alert webhook on new errors                                         |               |

## Open questions

- **`imageData` and large-binary defense in the shared logger.** Kokoro currently scrubs base64 image payloads via a module-level Pino formatter. Once logs leave the process, that defense needs to live in `@kagami/logger` (redact paths + a generic `omitOverSize` guard) so an accidental `logger.info({ imageData }, …)` from any service can't blow past the ingest body limit or pollute Mongo time-series buckets. See the implementation plan for the specific changes.
- **Mongo isolation.** Phase 0 reuses the existing workspace Mongo instance. If volume grows or blast-radius isolation becomes a concern, move Kansoku to a separate cluster.
- **Real-time latency.** The plan targets near-real-time (~500 ms log → dashboard) on a $5–10/mo VPS. If sustained rates exceed ~5k logs/sec, a Redis Streams buffer in front of Mongo becomes necessary — not built day one.
