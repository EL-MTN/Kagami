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

| Collection | Type                                             | Purpose                                                                                                               | Retention  |
| ---------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| `logs`     | time-series (`timeField: ts`, `metaField: meta`) | Every shipped log line. `meta: { service, component, env, level }`.                                                   | 30 days    |
| `metrics`  | time-series (`timeField: ts`, `metaField: meta`) | Pushed metrics. `meta: { service, name, tags }`. Phase 6+.                                                            | 30 days    |
| `errors`   | regular, `_id = fingerprint`                     | One doc per unique error. Holds `count`, sample message, sample stack, `firstSeen`, `lastSeen`, last-N trace IDs.     | indefinite |
| `spans`    | time-series (optional)                           | Derived from `logs` initially; promoted to a first-class collection if log-derived traces get too expensive to query. | 30 days    |

Indexes (Phase 1):

- `logs`: `{ "meta.service": 1, ts: -1 }`, `{ traceId: 1 }`, `{ "meta.level": 1, ts: -1 }`
- `errors`: `{ lastSeen: -1 }`, `{ service: 1, lastSeen: -1 }`

## Ingest path

```
service code
  └─ logger.info({ ... }, "msg")
        └─ pino multistream (in-process, no worker threads):
              ├─ stdout (pino-pretty in dev, raw JSON in prod)
              └─ kansoku-stream  (shared/packages/logger/src/kansoku-stream.ts)
                    └─ buffer (250ms or 50 events, whichever first)
                          └─ POST https://api.kansoku.localhost/v1/logs
                                ├─ constant-time check of x-kansoku-auth
                                ├─ Zod-validate envelope (apps/api/src/lib/envelope.ts)
                                ├─ normalize pino → StoredLog
                                │     (time → ts, numeric level → string,
                                │      service/component/env/level → meta,
                                │      everything else → fields)
                                └─ async insertMany into the `logs`
                                   time-series collection
                          └─ 202 Accepted { accepted: N }
```

The route returns 202 before the Mongo write resolves so the shipper's socket
closes fast. If Mongo is down at write time the events are lost (the shipper
has already moved on), but every step before insertMany is synchronous —
schema validation rejects malformed batches with 400 rather than swallowing
them.

### Wire envelope

Each batch is `application/json` — an array of pino log objects. The schema
(at `apps/api/src/lib/envelope.ts`) requires `time`, `level`, `service`,
`component`, `env` and accepts any additional fields via passthrough.
Recognized special keys: `msg`, `pid`, `hostname`, `traceId`, `spanId`.
Everything else lands under `fields` on the stored doc.

### Error / level upsert (Phase 4)

Phase 1 does **not** maintain the `errors` collection yet — that's Phase 4
once we have the fingerprinting helper and the dashboard surface to display
it. The `level: "error"` documents go into `logs` like everything else and
remain searchable via `GET /v1/logs?level=error`.

### Fail modes

| Failure                 | Behavior                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kansoku unreachable     | Shipper buffers up to 5000 events with exponential backoff (250ms→30s). On overflow, oldest dropped; count surfaced in `x-kansoku-dropped` header on next success. |
| Kansoku returns non-2xx | Batch requeued at the front of the buffer. Same backoff/drop behavior.                                                                                             |
| Token unset on server   | Every `POST /v1/logs` returns 503 fail-closed.                                                                                                                     |
| Wrong / missing token   | 401 unauthorized.                                                                                                                                                  |
| Malformed envelope      | 400 with Zod issues; entire batch rejected.                                                                                                                        |
| Mongo write fails       | Logged on the server (to its own stdout — not shipped, no loop); ack to shipper had already gone out.                                                              |

## Authentication

Phase 1 uses a shared HMAC token (`KANSOKU_INGEST_TOKEN`) carried as a request header (`x-kansoku-auth`). One token per Kagami install — rotation is a manual env change. Personal scale; no per-service identity needed yet.

## Dashboard surfaces

| Page          | Purpose                                                   | Backed by                             | Status  |
| ------------- | --------------------------------------------------------- | ------------------------------------- | ------- |
| `/`           | Overview cards + status                                   | `/health`, `/version`                 | live    |
| `/tail`       | Live stream, filter by service / level, pause/clear       | SSE `/v1/tail` (+ ring-buffer replay) | live    |
| `/search`     | Historical log search, time-range + service/level filters | `/v1/logs?service&level&since&until`  | live    |
| `/traces/:id` | Single-trace waterfall, log timeline                      | `/v1/traces/:id`                      | live    |
| `/errors`     | Grouped by fingerprint, sortable by `lastSeen` / `count`  | `/v1/errors`                          | Phase 4 |
| `/services`   | Per-service log volume sparklines, error rate, last-seen  | aggregations                          | Phase 6 |

### Live-tail wire format (Phase 2)

SSE stream from `GET /v1/tail?service=&level=&replay=`. Each `data:` line is
a `StoredLog` JSON object (same shape as the `GET /v1/logs` results).
Query params:

- `service` — exact match on `meta.service`. Optional.
- `level` — comma-separated list, e.g. `warn,error,fatal`. Defaults to all.
- `replay` — how many recent matching events to replay from the in-process
  ring buffer on connect (0–200, default 50). The ring holds the last 500
  ingested events across all services.

A keep-alive comment (`: heartbeat <ts>\n\n`) every 30 s prevents idle
proxies from collapsing the connection. The handler is single-user
localhost; no auth on the tail/query endpoints (cf. siblings).

### CORS

`/v1/*` echoes any `*.localhost` origin in `Access-Control-Allow-Origin` and
handles preflights for the dashboard. The token-authed ingest path is
unaffected — its callers are server-to-server, not browser-originating.

### Distributed tracing (Phase 3)

W3C [Trace Context](https://www.w3.org/TR/trace-context/) is the wire format.
A trace is identified by a 32-hex `traceId`; each unit of work within the
trace is a `spanId` (16 hex). Spans link to their `parentSpanId`.

Three pieces live in `@kagami/logger`:

- **`@kagami/logger/trace`** — `AsyncLocalStorage`-backed context store with
  `runWithTrace`, `getTraceContext`, ID generators, and `parseTraceparent` /
  `formatTraceparent` helpers.
- **`@kagami/logger/express-trace`** — middleware that reads the incoming
  `traceparent`, opens a child span if present (or mints a fresh trace
  otherwise), echoes the result on the response, and runs the rest of the
  request inside the ALS scope.
- **`@kagami/logger/traced-fetch`** — `tracedFetch(input, init)` reads the
  active context and stamps it on the outgoing request as `traceparent`. With
  no active context it's identical to `fetch`.

`createLogger` installs a pino `mixin` that reads the ALS context on every
log call and emits `traceId` / `spanId` / `parentSpanId`. No callers have to
thread context manually — every log line inside a traced request gets
enriched automatically. The shipper's envelope already accepts these fields,
and the server-side normalizer keeps them as top-level keys on `StoredLog`
for fast indexed lookup (`{ traceId: 1 }` sparse index).

`GET /v1/traces/:id` returns every log line sharing the given traceId,
oldest-first. The dashboard's `/traces/[id]` page groups by `spanId`, walks
parent-child links into a tree, and renders a waterfall (offset + duration
proportional to the total trace window) above a flat log timeline.

Phase 3 wires the middleware into Kioku and Kansoku itself; Kokoro and
Kizuna get it during the Phase 5 rollout sweep, at which point Kokoro's
`fetch` calls to Kioku/Kizuna are swapped for `tracedFetch` so a Telegram
message can be followed end-to-end across services.

## Phased delivery

| Phase | Scope                                                                                                   | Status      |
| ----- | ------------------------------------------------------------------------------------------------------- | ----------- |
| 0     | Scaffold (`kansoku/{apps,packages,docs}`, Portless URLs, workspace globs, `/health`)                    | done        |
| 1     | Mongo time-series setup, `/v1/logs` ingest, Zod envelope, kansoku-stream shipper, wire Kioku end-to-end | done        |
| 2     | Dashboard `/tail` (SSE) and `/search`                                                                   | done        |
| 3     | Trace context (ALS + middleware + `tracedFetch`), `/traces/:id` view                                    | **this PR** |
| 4     | Error fingerprinting + `/errors` page                                                                   |             |
| 5     | Roll out shipper to Kokoro and Kizuna; collapse any divergence                                          |             |
| 6     | Derived metrics + `/services` dashboard                                                                 |             |
| 7     | TTL policies, retention dial-in, optional alert webhook on new errors                                   |             |

## Open questions

- **Large-binary defense.** Phase 1 adds `imageData` (and one level of nesting) to `@kagami/logger`'s `DEFAULT_REDACT_PATHS` with a custom censor that replaces base64 with `"[base64 omitted, ~Nb]"` so the payload size is still observable without the bytes. A generic `omitOverSize` walk (replace any string > N bytes) is deferred — the redact list covers the realistic shapes we ship today.
- **Mongo isolation.** Phase 1 reuses the existing workspace Mongo instance with a dedicated `kansoku` database. If volume grows or blast-radius isolation becomes a concern, move Kansoku to a separate cluster.
- **Real-time latency.** Phase 1 targets near-real-time (~500 ms log → durable). If sustained rates exceed ~5k logs/sec, a Redis Streams buffer in front of Mongo becomes necessary — not built day one.
