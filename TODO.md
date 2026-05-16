# TODO

Deferred work from the logging review (2026-05-15). Already shipped to `main`:
error-field standardization (`{ error }` + `errorKey`/`stdSerializers.err`),
full redaction removal (local-trust only — see
`project_vps_deployment_intent.md`), Kokoro base64-in-logs fix, stale-doc
corrections, and the pre-existing Kioku test lint.

The three tracks below are the remaining gaps versus production-grade /
industry-standard logging. Ordered within each track by leverage.

Branch `logging-prod-hardening` (not yet on `main`) now ships **all three
tracks in full**, including both Decision forks (resolved with the user):
track 1 — string level / ISO time / TTY pretty gate **and the full ECS /
OTel field-name rename** (tolerant Kansoku ingest); track 2 — `sampled`
flag wiring **and build-light spans** (real `spans` collection + waterfall);
track 3 — Tier-1 `fetch` timeout, `kansoku-stream` tests, `errors` TTL,
`metaField` cardinality guard, head sampling, write-then-ack durability,
shipper hardening (jitter + drop policy). Nothing logging-track is open;
remaining boxes are all `[x]`. (Redaction reintroduction is still tracked
separately — see the note at the bottom.)

---

## 1. Structured JSON / schema portability

The wire format is JSON, but the schema fights off-the-shelf tooling
(Datadog/Loki/ELK/OTel) and the stdout gate is fragile.

- [x] **String level.** `formatters.level` emits `"level":"info"`.
      Kansoku ingest tolerates the legacy numeric form too (no lock-step
      restart needed). _(branch `logging-prod-hardening`)_
- [x] **ISO-8601 timestamp.** `timestamp: pino.stdTimeFunctions.isoTime`;
      Kansoku ingest also still accepts legacy epoch-ms.
      _(branch `logging-prod-hardening`)_
- [x] **TTY-based pretty gate.** `env`-based gate replaced with
      `shouldPretty()` — pretty only on an interactive stdout TTY or
      `LOG_PRETTY=1`/`true`; raw NDJSON otherwise.
      _(branch `logging-prod-hardening`)_
- [x] **Decision: ECS / OTel field names — DONE (chosen: do it now).**
      `@kagami/logger` emits nested ECS (`log.level`, `@timestamp`,
      `service.{name,environment,component}`, `host.name`, `process.pid`,
      `trace.id`, `span.{id,parent.id}`, `error.{type,message,stack_trace}`,
      `message`). The feared cross-service coupling didn't materialize:
      queries/dashboard read the normalized `StoredLog`, so the change was
      contained to `envelope.ts` (tolerant ECS+legacy) + `fingerprint.ts` +
      the shipper's level read. _(branch `logging-prod-hardening`)_

## 2. Distributed tracing

Trace **correlation** is already strong (W3C `traceparent` via
AsyncLocalStorage, auto-injected `traceId`/`spanId`, `tracedFetch`
propagation). What's missing is real **spans**.

- [x] **Decision: build vs. adopt OTel — DONE (chosen: build-light).**
      `@kagami/logger`'s `runWithSpan(name, fn)` opens a timed child span and
      emits one `event.kind:"span"` ECS log line via a sink `createLogger`
      registers. No SDK/exporter. _(branch `logging-prod-hardening`)_
- [x] Real spans exist. Kansoku folds span events into a regular `spans`
      collection (`storage/spans.ts`, `_id = traceId:spanId`);
      `GET /v1/traces/:id` returns `{ logs, spans }`; the dashboard renders a
      real waterfall (durations + parent/child + ok/error) with graceful
      fallback to the log-derived approximation for pre-spans traces.
      `kansoku/docs/architecture.md` reconciled (`spans` is a real regular
      collection; `metrics` marked reserved-not-created).
      _(branch `logging-prod-hardening`)_
- [x] `traced-fetch.ts` revisited: with `runWithSpan` available, an
      explicit span at the call site is the lightweight path; auto-minting a
      client RPC span inside `tracedFetch` is **intentionally not done**
      (keeps client/server on one span unless a caller opts in). Rationale
      recorded in `traced-fetch.ts`. _(branch `logging-prod-hardening`)_
- [x] Wire the existing-but-unused `sampled` flag in `TraceContext`.
      `newTraceContext` now makes a `LOG_SAMPLE_RATE` head decision;
      `childSpan`/`traceparent` propagate it; the mixin emits `sampled:false`
      and the shipper enforces it (see track 3 head sampling).
      _(branch `logging-prod-hardening`)_

## 3. Sampling + durability

No sampling anywhere; the ingest path is lossy by design.

**Sampling / cost / cardinality**

- [x] Head sampling for high-volume `debug`/`info`; always keep `warn`+.
      `LOG_SAMPLE_RATE` (default 1 = keep all) drives the per-root-trace
      `sampled` head decision; the shipper sheds below-`warn` lines on
      sampled-out traces producer-side (cheapest place, saves bandwidth);
      `warn`/`error`/`fatal` always ship. Kansoku ingest unchanged.
      _(branch `logging-prod-hardening`)_
- [x] Cardinality guard on Kansoku ingest `metaField`. Implemented as a
      process-lifetime distinct-tuple budget (`KANSOKU_MAX_META_COMBOS`,
      default 1000) in `kansoku/apps/api/src/lib/cardinality.ts`: over-budget
      tuples collapse to a fixed sentinel (level preserved). Also: 64-char
      cap on service/component/env, and unknown levels → `"unknown"`
      (was an unbounded `String(level)` leak). _(branch `logging-prod-hardening`)_

**Durability**

- [x] **[Tier-1] `fetch` timeout in the shipper.** `requestTimeoutMs`
      (default 10 s) + `AbortController` in `kansoku-stream.ts`: a hung
      connection aborts, the batch requeues onto the existing
      backoff/requeue path, the in-flight guard clears, and the shipper
      keeps draining. Regression-tested. _(branch `logging-prod-hardening`)_
- [x] Server-side durability: ingest is now **write-then-ack** with a
      bounded jittered retry; persistent failure → 503 so the shipper
      requeues into its bounded buffer (the producer-side durable queue)
      instead of the old fire-and-forget silent loss. Fingerprint upserts
      stay fire-and-forget (idempotent on resend).
      `kansoku/apps/api/src/routes/ingest.ts`. _(branch `logging-prod-hardening`)_
- [x] Shipper hardening: full-jitter backoff (no more thundering herd) and a
      configurable `dropPolicy` (`oldest` default | `newest` to preserve the
      incident head). Worker-thread transport **intentionally not done** —
      it conflicts with the in-process multistream composition and the
      synchronous trace-mixin read; rationale documented in
      `kansoku-stream.ts`. _(branch `logging-prod-hardening`)_
- [x] `errors` collection TTL. TTL index on `errors_last_seen`
      (`KANSOKU_ERRORS_TTL_DAYS`, default 90, capped 365); quiet
      fingerprints age out, active ones never expire. `ensureIndexes`
      reconciles a pre-existing non-TTL index in place via `collMod`.
      _(branch `logging-prod-hardening`)_
- [x] `kansoku-stream.ts` test suite — batch / requeue+order / backoff
      escalation / overflow accounting + `x-kansoku-dropped` / `final()`
      drain (incl. deadline) / request-timeout regression.
      `shared/packages/logger/tests/kansoku-stream.test.ts`.
      _(branch `logging-prod-hardening`)_

---

## Fork decisions (resolved)

Both forks were put to the user and implemented on this branch:

- **Build vs. adopt OpenTelemetry (track 2) → build-light.** `runWithSpan`
  emits span events from the existing `trace.ts` helpers; Kansoku stores a
  real `spans` collection. No OTel SDK/OTLP — the workspace already had
  working trace-by-`traceId`; only durations/waterfall were missing.
- **ECS / OTel field names (track 1) → done now.** Producer emits nested
  ECS; Kansoku ingest accepts ECS + legacy. The anticipated cross-service
  churn didn't materialize because the dashboard/queries read the
  normalized `StoredLog`, not the wire shape — so the change stayed
  contained to `envelope.ts`/`fingerprint.ts`/the shipper.

_Out of scope here but tracked elsewhere: redaction reintroduction is a
hard pre-VPS-exposure blocker recorded in `project_vps_deployment_intent.md`._
