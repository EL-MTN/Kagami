# Kansoku — Architecture

Kansoku (観測, "observation") is the Kagami workspace's centralized observability service: structured logs, distributed traces, error fingerprints, and metrics in one place, fed by producer services over HTTP.

## Why it exists

Until Kansoku, every service in Kagami logged to stdout and that was it — no aggregation, no cross-service correlation, no error grouping, no historical search. Hundreds of log call sites across the workspace evaporated the moment a terminal scrolled.

Kansoku consolidates those streams:

- **Logs** — every configured `logger.*` call from Kioku/Kokoro/Kizuna/Kao ships to Kansoku via a Pino transport added to `@kagami/logger`.
- **Traces** — incoming HTTP requests get a W3C `traceparent`-compatible context; outgoing `fetch` calls in Kokoro and Kizuna propagate it to Kioku, Kizuna, and Kao as appropriate; logs auto-include `traceId`/`spanId` via `AsyncLocalStorage`.
- **Errors** — `level >= error` events are fingerprinted (hash of `error.name + error.message + top stack frame`, plus a bounded `.cause` / `AggregateError` chain when present) and rolled up into a per-fingerprint document with `firstSeen`, `lastSeen`, `count`, and a bounded list of recent trace IDs.
- **Metrics** — derived from logs in Phase 1 (counts, error rates, `durationMs` percentiles), with an explicit `metric(name, value, tags?)` API added in Phase 6 when log-derived isn't enough.

## Posture

Kansoku is **push-only-in**. It never initiates outbound calls to siblings. Every shipper at every call site is **fail-open** — a network error talking to Kansoku must never wedge a sibling service. The Pino transport keeps a bounded in-memory ring buffer (~5 minutes); on overflow it drops oldest and increments a local counter that gets shipped on next successful flush.

## Data model

MongoDB is the only store. The existing workspace Mongo instance is reused with a dedicated database (`kansoku`).

| Collection | Type                                             | Purpose                                                                                                            | Retention                                        |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `logs`     | time-series (`timeField: ts`, `metaField: meta`) | Every shipped log line (incl. span-event lines). `meta: { service, component, env, level }`.                       | `KANSOKU_LOGS_TTL_DAYS` (30)                     |
| `errors`   | regular, `_id = fingerprint`                     | One doc per unique error. Holds `count`, sample message, sample stack, `firstSeen`, `lastSeen`, last-N trace IDs.  | `KANSOKU_ERRORS_TTL_DAYS` (90) TTL on `lastSeen` |
| `spans`    | regular, `_id = traceId:spanId`                  | Build-light: one doc per completed `runWithSpan`, folded from `event.kind:"span"` log lines. Drives the waterfall. | `KANSOKU_LOGS_TTL_DAYS` TTL on `startedAt`       |

Indexes:

- `logs`: `{ "meta.service": 1, ts: -1 }`, `{ traceId: 1 }`, `{ "meta.level": 1, ts: -1 }`
- `errors`: `{ lastSeen: -1 }` (TTL), `{ service: 1, lastSeen: -1 }`
- `spans`: `{ traceId: 1, startedAt: 1 }`, `{ startedAt: -1 }` (TTL)

## Ingest path

```
service code
  └─ logger.info({ ... }, "msg")
        └─ pino multistream (in-process, no worker threads):
              ├─ stdout (pino-pretty on a TTY or LOG_PRETTY=1, else raw JSON)
              └─ kansoku-stream  (shared/packages/logger/src/kansoku-stream.ts)
                    └─ buffer (250ms or 50 events, whichever first)
                          └─ POST https://api.kansoku.localhost/v1/logs
                                ├─ constant-time check of x-kansoku-auth
                                ├─ Zod-validate envelope (apps/api/src/lib/envelope.ts)
                                ├─ normalize pino → StoredLog
                                │     (time epoch-ms|ISO → ts Date,
                                │      level numeric|string → name,
                                │      meta passed through the cardinality
                                │      guard, everything else → fields)
                                ├─ broadcast to live-tail subscribers
                                └─ await insertMany into the `logs`
                                   time-series collection (bounded retry)
                          └─ 202 Accepted { accepted: N }  (or 503 → requeue)
```

Ingest is **write-then-ack**: the live-tail broadcast is synchronous, but
the 202 is held until the bulk write durably lands (a bounded, jittered
retry absorbs transient Mongo errors). If the write keeps failing the route
responds 503, and the shipper — which treats any non-2xx as a failure —
requeues the batch into its bounded local buffer and backs off. So a Mongo
outage degrades to "buffered at the producer + retried", not the old
fire-and-forget total silent loss. Fingerprint upserts stay fire-and-forget
(derived and idempotent on resend). Schema validation still rejects
malformed batches with 400 before any of this.

### Wire envelope

Each batch is `application/json` — an array of pino log objects.
`apps/api/src/lib/envelope.ts` accepts **two shapes** and normalizes both to
the same internal `StoredLog`:

- **ECS / OTel (current `@kagami/logger`)** — nested: `@timestamp`,
  `log.level`, `service.{name,environment,component}`, `host.name`,
  `process.pid`, `trace.id`, `span.{id,parent.id}`, `message`,
  `error.{type,message,stack_trace}`.
- **Legacy (pre-ECS pino)** — flat: `time` (epoch-ms or ISO), `level`
  (numeric or string), `service`/`component`/`env`, `msg`, `pid`,
  `hostname`, `traceId`/`spanId`/`parentSpanId`.

ECS wins when both are present. Tolerating both means producers and the
consumer never restart in lock-step. Everything not consumed (incl.
`error`, `sampled`, `event`, user fields) lands under `fields`. `time`
normalizes to a `Date`, `level` to a known lowercase name (unrecognized →
`"unknown"`), `service`/`component`/`env` are capped at 64 chars, and the
normalized `meta` tuple passes through the cardinality guard (below) before
storage. Because everything downstream reads `StoredLog`, the ECS rename
stayed contained to `envelope.ts` (+ `fingerprint.ts` reading
`error.type`/`error.stack_trace`, and the shipper reading `log.level`).

### Retention + alerts (Phase 7)

The `logs` time-series TTL is configurable via `KANSOKU_LOGS_TTL_DAYS`
(default 30, capped at 365). On startup, `ensureIndexes` creates the
collection at that TTL on first boot and reconciles via `collMod` on
subsequent boots — so dialing retention up or down is just an env edit and
a restart. Other time-series options (`timeField`, `metaField`,
`granularity`) still require a manual drop + recreate.

The `errors` registry (a regular collection) now also has a retention TTL,
`KANSOKU_ERRORS_TTL_DAYS` (default 90, capped at 365), implemented as a TTL
index on `errors_last_seen`. A fingerprint that stops recurring ages out
that many days after its last hit; an active one keeps refreshing
`lastSeen` and never expires. `ensureIndexes` creates the TTL index or
reconciles a pre-existing non-TTL `errors_last_seen` in place via
`collMod`.

**Cardinality guard.** A time-series collection buckets per distinct
`metaField` value, so an unbounded number of distinct
`{service,component,env,level}` tuples (a buggy producer putting a request
id in `component`, say) explodes bucket count and tanks ingest + `$group`
queries. `apps/api/src/lib/cardinality.ts` keeps a process-lifetime budget
of distinct tuples (`KANSOKU_MAX_META_COMBOS`, default 1000); tuples seen
under budget pass through, and once it's exhausted every _new_ tuple
collapses into one fixed sentinel bucket (level preserved, already bounded
to 7 names). Worst-case added cardinality is therefore `budget + |levels|`
regardless of producer behavior. A throttled `warn` names a sample
offending tuple so the bug stays diagnosable.

### Shipper hardening (Phase 8)

No log sampling: this is a single-user system, so every log ships in full.
(The W3C `sampled` bit still rides `traceparent` for spec correctness and
defaults to "sampled" — but no producer ever clears it.)

**Backoff + overflow.** Backoff is full-jitter (the doubling ceiling, then a
uniform wait in `[1, ceil]`) so a fleet of shippers reconnecting after a
Kansoku blip doesn't resynchronize onto one retry tick. `dropPolicy`
(`"oldest"` default, recency-biased; `"newest"` preserves the incident
head) selects which end overflow discards. The shipper stays an in-process
stream (not a pino worker-thread transport) by design — it composes in the
same multistream as the console stream and the trace mixin reads
AsyncLocalStorage synchronously at log-call time; a worker boundary would
sever both, and the shipper does no CPU-bound work.

Alerts are optional, gated by `KANSOKU_ALERT_WEBHOOK_URL`. The hook is
fail-open at every step (5 s abort, errors swallowed) so an alerting
outage can't wedge ingest. Two payload kinds share the same URL:

**`kansoku.error.new`** — fires when an `upsertedCount > 0` upsert
records a brand-new fingerprint. Re-occurrences of a known fingerprint
do NOT re-fire this.

```json
{
  "kind": "kansoku.error.new",
  "fingerprint": "<16-hex>",
  "service": "kioku-api",
  "component": "api",
  "name": "TypeError",
  "message": "Cannot read properties of undefined…",
  "firstSeen": "2026-05-14T12:00:00.000Z",
  "traceId": "<32-hex>"
}
```

**`kansoku.error.spike`** — fires when a known fingerprint's count
inside the rolling window crosses `KANSOKU_SPIKE_THRESHOLD` (default
10, floor 2). Subsequent crossings of the same fingerprint stay silent
for `KANSOKU_SPIKE_COOLDOWN_MINUTES` (default 60). Window width is
`KANSOKU_SPIKE_WINDOW_MINUTES` (default 5). All three are strict
positive integers; non-integer or below the floor falls back with a
warn. Both `windowStart` and `lastSeen` in the payload are wall-clock
(the moment the spike was detected), so consumers don't have to
reconcile two time domains.

```json
{
  "kind": "kansoku.error.spike",
  "fingerprint": "<16-hex>",
  "service": "kioku-api",
  "component": "api",
  "name": "TypeError",
  "message": "Cannot read properties of undefined…",
  "count": 12,
  "windowMinutes": 5,
  "windowStart": "2026-05-14T12:00:00.000Z",
  "lastSeen": "2026-05-14T12:03:42.000Z",
  "traceId": "<32-hex>"
}
```

Implementation lives in `storage/errors.ts`. Per fingerprint the
`errors` doc tracks `windowStart`, `windowCount`, and
`lastSpikeAlertAt`; these are server-side projection-stripped from
`GET /v1/errors` responses so the wire shape is unchanged for the
dashboard and `kansoku-debug`.

**Storage upsert** — `recordErrors` groups the incoming docs by
fingerprint and issues one aggregation-pipeline `updateOne` per
group. The pipeline uses `$min` / `$max` / `$ifNull` / `$add` /
`$concatArrays`-with-`$slice` so the same shape works on insert and
update, and so the doc state is monotonic across out-of-order or
replayed batches: `firstSeen` only moves earlier, `lastSeen` only
moves later, `count` accumulates, `recentTraceIds` is capped at 20
post-concat. The TTL index on `errors_last_seen` is therefore safe
against a replay batch rewinding `lastSeen` and prematurely
evicting an active fingerprint.

**Spike eval** — `evaluateSpike` runs only when (a) the upsert
didn't insert (existing fingerprint), (b) at least one doc in the
group is within the spike window, and (c) `KANSOKU_ALERT_WEBHOOK_URL`
is set. Replay-only groups produce `inWindowIncrement === 0` and
skip eval; the storage upsert still records them. The `increment`
passed to `evaluateSpike` is the count of in-window docs only, so a
mixed batch of stale + fresh docs counts only the fresh ones toward
spike — even when the array order happens to place a fresh doc last
(or first).

**Same-batch protection** — a brand-new fingerprint with 100 logs
in one batch fires the new-error alert once and never trips spike
from its own first sighting. The window seed is `windowCount: 0`
(not `groupDocs.length`) so the next batch's eval doesn't inherit a
phantom backlog: a single follow-up error rolls windowCount to 1,
not 101.

**Window roll** — aggregation-pipeline `findOneAndUpdate` with a
hoisted `__reset` predicate (so the boolean isn't duplicated for
both the `windowStart` and `windowCount` `$cond`s, and so legacy
partial state — `windowStart` set but `windowCount` missing — also
triggers a reset).

**Cooldown claim** — a conditional `updateOne` atomically sets
`lastSpikeAlertAt`; the guard checks `matchedCount === 0` (not
`modifiedCount`) so a byte-identical post-image can't be misread as
a missed claim.

Both shapes work directly with Discord/Slack-style hooks, and a generic
endpoint can map them onward.

### Derived metrics (Phase 6)

Service-level metrics are computed on read by aggregating over the existing
`logs` time-series collection — no second ingestion pipeline. The Phase 1
index `{ "meta.service": 1, ts: -1 }` covers both queries; at Kagami's
personal scale (10–100 logs/sec peak) running them on every dashboard
fetch is cheaper than maintaining derived materialized rollups.

`GET /v1/services?windowHours=24` returns one row per service over the
window: total log count, error count (`level: error|fatal`), warn count,
last-seen timestamp, distinct components observed.

`GET /v1/services/:service/timeline?windowHours=24&granularity=hour`
returns sparse buckets `{ ts, count, errorCount }` for that service. The
route auto-picks a granularity when one isn't supplied: `minute` for ≤2 h,
`day` for ≥7 d, `hour` otherwise.

The dashboard `/services` page renders one card per service with three
quick-read stats (logs, errors, error %), a volume sparkline tinted red
when the window has any errors, an error-rate sparkline when relevant,
and a `last seen` chip. Each card links into `/search?service=<svc>` so
inspection is one click away. Window selection (1h / 6h / 24h / 7d) is a
querystring switch — no client state.

An explicit `metric(name, value, tags?)` push API is intentionally
deferred until log-derived isn't enough. Counters and `durationMs`
percentiles already live in the existing log corpus.

### Error fingerprinting (Phase 4)

On every accepted batch, the ingest path runs each `level: error|fatal` doc
through `fingerprintErrorLog` (`apps/api/src/lib/fingerprint.ts`) and upserts
the result into a regular (non-time-series) `errors` collection keyed by
fingerprint. The hash inputs are:

- `meta.service` — so the same code path in different services stays distinct
- error `name` if present (from a structured `err`/`error`/`cause` object)
- the error `message`, run through a normalizer that replaces ISO
  timestamps, UUIDs, Mongo ObjectIds, and long numeric runs with placeholders
  so the same failure with varying IDs collapses to one fingerprint
- first non-internal stack frame when a `stack` field is present
- a bounded `.cause` / `AggregateError` chain (each link normalized like the
  message) when present

Each upsert is a single aggregation-pipeline `updateOne` (so first-seen fields
seed once and the counters fold in the same op):

- `$min firstSeen` / `$max lastSeen`
- `$add` to `count`
- `$concatArrays` + `$slice: -20` on `recentTraceIds` so the dashboard can
  drill straight into the most recent trace
- `$ifNull` seeds for `service`, `component`, `name`, `message`, `sampleMsg`,
  `sampleStack` (the original sample is kept verbatim, not overwritten by
  later churn)

`GET /v1/errors?service=&limit=` returns the registry sorted by `lastSeen`
desc. The dashboard `/errors` page renders each group with name + message,
service/component, count, first/last-seen relative times, and an arrow link
to the latest trace.

Logs themselves still go into the time-series `logs` collection unchanged —
fingerprinting writes are additive (and fail-open: a failed errors write
must never wedge the bulk log write).

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

| Page          | Purpose                                                                      | Backed by                             | Status |
| ------------- | ---------------------------------------------------------------------------- | ------------------------------------- | ------ |
| `/`           | Overview cards + status                                                      | `/health`, `/version`                 | live   |
| `/tail`       | Live stream, filter by service / level, pause/clear                          | SSE `/v1/tail` (+ ring-buffer replay) | live   |
| `/search`     | Historical log search, time-range + service/level filters                    | `/v1/logs?service&level&since&until`  | live   |
| `/traces/:id` | Single-trace waterfall, log timeline                                         | `/v1/traces/:id`                      | live   |
| `/errors`     | Grouped by fingerprint, ordered by `lastSeen` desc (filter by service/limit) | `/v1/errors`                          | live   |
| `/services`   | Per-service log volume sparklines, error rate, last-seen                     | aggregations                          | live   |

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

`GET /v1/traces/:id` returns `{ traceId, logs, spans }` — every log line
sharing the traceId (oldest-first) plus any real spans.

### Build-light spans (Phase 8)

The "build" fork of the spans decision (vs. adopting OpenTelemetry).
`@kagami/logger`'s `runWithSpan(name, fn)` opens a child span of the active
trace, times it, and emits **one ECS log line** on completion:
`event.kind:"span"` + `event.{name,duration_ms,status}` + the span's own
`trace.id`/`span.id`/`span.parent.id` (via a sink `createLogger` registers —
it overrides the mixin so the line carries the span's own ids, not the
parent's). No SDK, no second exporter: a span event is just a log, so it
also shows in tail/search.

Kansoku ingest folds those lines into the regular `spans` collection
(`storage/spans.ts`, `_id = traceId:spanId`, idempotent on resend,
fire-and-forget like error fingerprints). The dashboard `/traces/[id]` page
renders a real waterfall from `spans` (accurate `durationMs`, explicit
parent/child tree, ok/error status) when present, and **gracefully falls
back** to the old log-timestamp-derived approximation for traces that
predate this. `tracedFetch` still deliberately mints no client RPC span —
with `runWithSpan` available, an explicit span at the call site is the
lightweight path; auto-instrumenting fetch is intentionally not done.

Phase 3 wires the middleware into Kioku and Kansoku itself; Phase 5
extends it to Kokoro (Grammy middleware per Telegram update, the same
trace wrap on the BlueBubbles webhook) and Kizuna (Express middleware in
`createApp`). Kokoro's Kioku and Kizuna HTTP clients now use `tracedFetch`
from `@kokoro/shared`, so a Telegram message can be followed end-to-end
across all three services.

## Debug CLI (`kansoku-debug`)

A read-only CLI at `apps/api/scripts/kansoku-debug.ts` mirrors the dashboard's query surfaces for terminal use — designed for Claude Code agents and humans who want to inspect a trace, search logs, or scan recent errors without standing up the dashboard. Invoked from the workspace root as `npm run kansoku:debug -- <subcommand>`.

Subcommands map 1:1 onto the API:

| Subcommand            | Endpoint             | Output                                                              |
| --------------------- | -------------------- | ------------------------------------------------------------------- |
| `trace <id>`          | `GET /v1/traces/:id` | Span-tree waterfall (ASCII) + log timeline with inline error fields |
| `logs [filters]`      | `GET /v1/logs`       | Newest-first log table + unique-trace-IDs footer for drill-in       |
| `errors [filters]`    | `GET /v1/errors`     | Fingerprint registry with the last 5 of up to 20 `recentTraceIds`   |
| `services [--window]` | `GET /v1/services`   | Per-service log/error/warn counts in a time window                  |

Global flags: `--json` (raw API payload), `--url BASE` (override `KANSOKU_URL`, default `https://api.kansoku.localhost`).

TLS posture: the CLI uses `node:https` with per-request `rejectUnauthorized:false` scoped to `.localhost` hostnames — no global env var, no Node TLS warning. Public URLs keep full verification.

Auth posture: the CLI consumes the existing unauthenticated read surface. This is acceptable today because the API only binds to 127.0.0.1 under Portless. Before any VPS exposure the read surface must be gated; see [Authentication](#authentication) and the open questions below.

The `.claude/skills/kansoku-debug/SKILL.md` skill teaches future Claude Code sessions the typical workflows (`errors → trace`, `logs → trace`, "did my fix take") that this CLI supports.

## Phased delivery

| Phase | Scope                                                                                                                                                                                                                                           | Status      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 0     | Scaffold (`kansoku/{apps,packages,docs}`, Portless URLs, workspace globs, `/health`)                                                                                                                                                            | done        |
| 1     | Mongo time-series setup, `/v1/logs` ingest, Zod envelope, kansoku-stream shipper, wire Kioku end-to-end                                                                                                                                         | done        |
| 2     | Dashboard `/tail` (SSE) and `/search`                                                                                                                                                                                                           | done        |
| 3     | Trace context (ALS + middleware + `tracedFetch`), `/traces/:id` view                                                                                                                                                                            | done        |
| 4     | Error fingerprinting + `/errors` page                                                                                                                                                                                                           | done        |
| 5     | Roll out shipper to Kokoro and Kizuna; collapse any divergence                                                                                                                                                                                  | done        |
| 6     | Derived metrics + `/services` dashboard                                                                                                                                                                                                         | done        |
| 7     | TTL policies, retention dial-in, optional alert webhook on new errors                                                                                                                                                                           | done        |
| 8     | Prod-hardening (branch `logging-prod-hardening`): TTY pretty gate, shipper `fetch` timeout + jitter + drop policy, write-then-ack ingest, `errors` TTL, meta cardinality guard, ECS/OTel field-name rename (tolerant ingest), build-light spans | **this PR** |

## Open questions

- **Large-binary defense.** `@kagami/logger` currently ships no redaction or size-cap walk — the workspace is local-trust only, so the previous `imageData` base64-censor and any generic `omitOverSize` walker have been removed. Before any non-localhost exposure, reintroduce both: a path-based redact list (at minimum `imageData` and one level of nesting, with a base64-aware censor that preserves observed payload size) plus a generic string-length cap on `fields`.
- **Mongo isolation.** Phase 1 reuses the existing workspace Mongo instance with a dedicated `kansoku` database. If volume grows or blast-radius isolation becomes a concern, move Kansoku to a separate cluster.
- **Real-time latency.** Phase 1 targets near-real-time (~500 ms log → durable). If sustained rates exceed ~5k logs/sec, a Redis Streams buffer in front of Mongo becomes necessary — not built day one.
