# TODO

Deferred work from the logging review (2026-05-15). Already shipped to `main`:
error-field standardization (`{ error }` + `errorKey`/`stdSerializers.err`),
full redaction removal (local-trust only — see
`project_vps_deployment_intent.md`), Kokoro base64-in-logs fix, stale-doc
corrections, and the pre-existing Kioku test lint.

The three tracks below are the remaining gaps versus production-grade /
industry-standard logging. Ordered within each track by leverage.

Branch `logging-prod-hardening` (not yet on `main`) ships the non-decision,
non-architectural subset: track 1's string level / ISO time / TTY pretty
gate (with tolerant Kansoku ingest), and track 3's Tier-1 `fetch` timeout,
`kansoku-stream` test suite, `errors` TTL, and `metaField` cardinality
guard. The remaining open items are the explicit **Decision:** forks plus
server-side durability and shipper hardening.

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
- [ ] **Decision: adopt ECS or OTel field names** (`service.name`,
      `log.level`, `error.*`, `trace.id`). Bigger, breaking change —
      **cross-service coupling**: Kansoku's ingest envelope
      (`kansoku/apps/api/src/lib/envelope.ts`) hard-codes numeric `level` /
      numeric `time`, and the query routes + dashboard read those. Any
      producer schema change must land Kansoku ingest + queries + dashboard
      in the same PR (producer-before-consumer in one commit).

## 2. Distributed tracing

Trace **correlation** is already strong (W3C `traceparent` via
AsyncLocalStorage, auto-injected `traceId`/`spanId`, `tracedFetch`
propagation). What's missing is real **spans**.

- [ ] **Decision: build vs. adopt OpenTelemetry.** This is the
      architectural fork — pick before doing the items below. - Build-light: emit explicit span lifecycle events (start/end,
      `durationMs`, parent/child, status) from the `@kagami/logger` trace
      helpers (`runWithTrace`/`childSpan` in `trace.ts`) and have Kansoku
      store + aggregate a real `spans` collection. - Adopt: OTel SDK + OTLP exporter; Kansoku grows an OTLP endpoint or
      point at an OTel-native backend.
- [ ] Today a "trace" is just `logs.find({ traceId })`
      (`kansoku/apps/api/src/storage/logs.ts`) — no durations, no waterfall.
      The documented `spans`/`metrics` collections don't exist in code;
      reconcile `kansoku/docs/architecture.md` once decided.
- [ ] `traced-fetch.ts` deliberately does **not** mint a client RPC span
      (client and server share one span) — revisit for a real client/server
      split once spans exist.
- [ ] Wire the existing-but-unused `sampled` flag in `TraceContext`
      (`trace.ts`) — overlaps with track 3.

## 3. Sampling + durability

No sampling anywhere; the ingest path is lossy by design.

**Sampling / cost / cardinality**

- [ ] Head sampling for high-volume `debug`/`info`; always keep `warn`+,
      errors, and traced-error paths. Honor the `sampled` flag end-to-end
      (producer multistream + Kansoku ingest).
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
- [ ] Server-side durability: ingest returns `202` _before_ the Mongo
      write (`kansoku/apps/api/src/routes/ingest.ts`), no queue/retry/DLQ →
      total silent loss during a Mongo outage. Add write-then-ack with a
      bounded queue, or a producer-side spill/DLQ.
- [ ] Shipper hardening: drop-**oldest** on overflow loses
      start-of-incident lines; no retry jitter (thundering herd on Kansoku
      recovery); runs on the event loop (no worker-thread transport).
      `kansoku-stream.ts`.
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

_Out of scope here but tracked elsewhere: redaction reintroduction is a
hard pre-VPS-exposure blocker recorded in `project_vps_deployment_intent.md`._
