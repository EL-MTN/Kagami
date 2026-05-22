# Memory subsystem

Long-term memory is delegated to [Kioku](https://github.com/EL-MTN/Kioku), a separate atomic-fact store + hybrid-retrieval service. Kokoro talks to it via HTTP. This doc covers the Kokoro side of the integration; see Kioku's own README for the storage and ranking internals.

## Layout

```
shared ← db ← memory ← bot
                     ← dashboard (TBD)
```

`@kokoro/memory` is the only Kokoro module that knows Kioku exists. Bot tools, schedulers, and context assembly depend on it; nothing else talks to Kioku directly.

```
packages/memory/src/
  index.ts         typed `tracedFetch` wrapper around Kioku's REST API
                   (W3C `traceparent` is stamped on every outgoing call so
                   Kioku's middleware threads them onto Kokoro's trace)
  transcript.ts    IConversation → Kioku transcript markdown
  ingest.ts        ingestClosedSession (fire-and-forget) + ingestClosedSessionAwaited
  sweeper.ts       sweepPendingIngests + sweepPendingFacts + sweepStaleActiveSessions
```

`apps/bot/src/ai/tools/memory.ts` — AI SDK tool factories (`searchMemory`, `rememberFact`).

## Configuration

| Env var     | Default                       | Purpose                                                |
| ----------- | ----------------------------- | ------------------------------------------------------ |
| `KIOKU_URL` | `https://api.kioku.localhost` | Kioku service base URL. Validated as a URL at startup. |

Run Kioku locally per its README. Prefer the [Portless](https://github.com/vercel-labs/portless) API host (`https://api.kioku.localhost`, registered as `api.kioku` in `Kioku/portless.json`). Set `KIOKU_URL=http://localhost:7777` only when running Kioku standalone outside Portless.

## Read paths

### `searchMemory` tool (LLM-driven, on demand)

The dominant read path. Mashiro calls it whenever past context would help. Available in:

- `allTools(ctx)` — main conversational and proactive flows
- `watcherTools(ctx)` — watchers can read but never write

Forwards to `@kokoro/memory.recall()` → `POST /recall`. Kioku ranks via cosine + BM25 + entity boost and returns top-K facts. Default `k = 8`. Optional `since` / `until` clamp `event_date`.

**Fail-open:** on Kioku outage the tool returns `{success: false, degraded: true, facts: []}` so the LLM keeps responding instead of stalling.

### Sweeper probe

Before re-ingesting a `pending` session, the sweeper calls `hasFactsForSession("raw/" + convo.sessionId)` to check if Kioku already has facts tagged with that session (Kioku tags transcript-extracted facts under the `raw/<sessionId>` source). If so, it just marks `done` instead of re-ingesting (avoids paraphrased duplicates from extraction-LLM variance).

### External MCP clients

Kioku also exposes `recall`, `query` (with answerer LLM), `view` (vault files), and `fact_count` over its `/mcp` endpoint. Out of scope here; see Kioku's docs.

## Write paths

### Automatic — session-close transcript ingest

When `getOrCreateSession` rolls over a stale session (>1h idle) and a new message arrives, the closed conversation is shipped to Kioku for fact extraction. Four call sites pick up the `previouslyClosed` return:

- `apps/bot/src/ai/generate.ts` — every inbound user message
- `apps/bot/src/ai/acknowledge.ts` — confirmation acknowledgments
- `apps/bot/src/scheduler/proactive.ts` — proactive messages
- `apps/bot/src/services/confirmation-events.ts` — when a tap-to-approve resolves

Each calls `ingestClosedSession(convo)` — fire-and-forget. The new turn doesn't wait. The helper short-circuits when the closed conversation has no **user** content (proactive-only sessions where the user never replied — `transcriptHasContent` requires at least one user turn so the extractor doesn't invent "the assistant offered…" facts from a one-sided transcript). On short-circuit it flips `ingestStatus` to `done` so the sweeper doesn't pick it up; otherwise it serializes via `buildTranscript` and calls Kioku's `POST /sessions`. On success the conversation's `ingestStatus` flips `pending → done` and `ingestedAt` is recorded. On failure, the handling depends on whether re-running the transcript could help (`countsTowardIngestCap`): a **deterministic** failure — an HTTP 500 (every extraction batch failed), a 4xx like 400 (malformed), or a client-side request timeout (Kioku reachable but too slow) — bumps `ingestAttempts` and, past `MAX_INGEST_ATTEMPTS` (5), flips the status to terminal `failed`. A **transient** failure — a connection/transport error (Kioku down), or a 429/503 ("retry later"; the 5/min `/sessions` limiter makes 429 routine during sweep bursts) — charges no attempt and leaves the status `pending`, so an outage or rate-limit recovers via unbounded sweeper retries. Either way the sweeper takes over.

The transcript shape (see `packages/memory/src/transcript.ts`) is YAML-frontmatter markdown — `id`, `started_at`, then `## t-N user` / `## t-N assistant` blocks. System and tool messages are dropped; only user/assistant turns with non-empty content are emitted.

### Sweeper-driven (correctness layer)

Every 5 minutes the maintenance scheduler (`apps/bot/src/scheduler/maintenance.ts`, started from `apps/bot/src/index.ts`) runs Kioku recovery on the same tick — stale-active first, pending session-ingest second, pending one-off facts third:

- **`sweepPendingIngests`** — finds `{closed && (ingestStatus pending or absent) && closedAt < now-60s}` (default `stalenessMs: 60_000`, `maxPerSweep: 10`, ordered oldest-first by `closedAt`). For each match it probes Kioku via `hasFactsForSession("raw/<sessionId>")` and, if facts already exist, marks the conversation `done` ("reconciled"). Otherwise it calls `ingestClosedSessionAwaited`, which gives up (terminal `failed`, counted as `abandoned`) once a reachable Kioku has errored `MAX_INGEST_ATTEMPTS` times — so a transcript that deterministically fails extraction stops being re-run every tick, and the terminal status drops out of this query. Matches legacy documents that pre-date the `ingestStatus` field via `$or: [{ ingestStatus: "pending" }, { ingestStatus: { $exists: false } }]`.
- **`sweepPendingFacts`** — drains one-off facts queued by `rememberFact` and place-learning when Kioku append fails. It processes due `PendingFact` rows (default `maxPerSweep: 25`), retries with exponential backoff (5 minutes → 10 → 20 → 40 → max 60), and marks rows `failed` after 5 attempts.
- **`sweepStaleActiveSessions`** — finds `{active && updatedAt < now-6h}` (default `idleHours: 6`, `maxPerSweep: 50`), flips them to `closed` with a fresh `closedAt`, and explicitly sets `ingestStatus: "pending"` so the next pending sweep picks them up. Catches sessions where the user idled for days and never returned.

A one-shot run also fires 30s after process start so a fresh boot recovers anything that was pending when the previous process died.

This scheduler used to live in `proactive.ts`; commit a1d8f36 ("Extract maintenance jobs out of proactive scheduler") moved it out alongside daily DB cleanup.

The trigger is the latency optimization; the sweeper is the correctness layer. If the trigger ever misses (Kioku down, future fifth call site, manual `closeSession`, crash mid-trigger), the sweeper recovers within minutes.

### LLM-driven — `rememberFact` tool

When Mashiro decides a fact is worth keeping across sessions, she calls `rememberFact(text, eventDate?)` (defined in `apps/bot/src/ai/tools/memory.ts`). Forwards to `@kokoro/memory.appendFactWithRetryQueue()` → `POST /facts` with `source_session: "rememberFact"`. Kioku does cosine dedup against existing in-scope facts, embeds, lemmatizes, and upserts entities. Idempotent — near-paraphrases of an existing fact return `{status: "duplicate", similarity}` with the existing id. If Kioku append fails, the fact is stored as a `PendingFact` and `sweepPendingFacts` retries it. Available in conversational paths; **excluded from watcher contexts** (watchers are read-only). The exact cosine threshold lives in Kioku, not Kokoro.

### Place-learning (passive)

`apps/bot/src/services/location.ts:learnPlace` watches for frequent visits using `PLACE_LEARNING_VISITS` (default `3`) within `PLACE_LEARNING_RADIUS_M` meters (default `200`) over `PLACE_LEARNING_WINDOW_DAYS` days (default `30`). When the threshold trips, it calls `appendFactWithRetryQueue` (with `source_session: "location-learning"`) with `"User frequently visits {placeName} ({placeCategory})."` Format is stable so cosine dedup at the append path catches re-saves (identical text gets cosine 1.0; well above the 0.97 threshold).

## Conversation schema

`IConversation` (in `@kokoro/db`) has three new fields tracking the ingest lifecycle:

| Field            | Type                                  | Default     | Purpose                                                                                                                                                                                                             |
| ---------------- | ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingestStatus`   | `"pending"` \| `"done"` \| `"failed"` | `"pending"` | Lifecycle of session-close ingest. Sweeper drives → done; → terminal `failed` after `MAX_INGEST_ATTEMPTS` reachable errors.                                                                                         |
| `ingestedAt`     | `Date?`                               | —           | Timestamp when Kioku confirmed extraction.                                                                                                                                                                          |
| `ingestAttempts` | `number`                              | `0`         | Bumped on each failure that re-running can't fix (`countsTowardIngestCap`: 5xx/4xx + client timeout); at `MAX_INGEST_ATTEMPTS` the status goes terminal `failed`. Transient failures (outage, 429/503) don't count. |

Indexed by `{ status, ingestStatus, closedAt }` for the sweeper query.

## Failure modes and recovery

| Failure                                                                                   | Recovery                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kioku unreachable on session rollover                                                     | Trigger throws but is caught internally; `ingestStatus` stays `pending`. Sweeper retries in ≤5 min.                                                                                |
| Crash mid-trigger before status update                                                    | Same as above. Sweeper probes Kioku first; if facts already landed, just flips status to `done`.                                                                                   |
| User idles for days; session never rolls over                                             | `sweepStaleActiveSessions` closes after 6h. Next pending sweep ingests.                                                                                                            |
| Legacy session pre-dates `ingestStatus` field                                             | Pending-sweep query matches `{ ingestStatus: { $exists: false } }` too.                                                                                                            |
| LLM extraction text drifts on retry                                                       | Pre-ingest probe via `hasFactsForSession` skips re-ingest if any facts already match the session.                                                                                  |
| Kioku returns 5xx on `searchMemory`                                                       | `searchMemory` returns `{degraded: true, facts: []}`. Bot responds without memory context.                                                                                         |
| Kioku unreachable on `rememberFact`/place-learning                                        | Fact is queued in `PendingFact`; `sweepPendingFacts` retries with backoff and marks failed after max attempts.                                                                     |
| Transcript deterministically fails extraction (Kioku reachable, every batch errors → 500) | `ingestAttempts` climbs; after `MAX_INGEST_ATTEMPTS` reachable errors the session is marked terminal `failed` so the sweeper stops re-running the LLM pipeline against it forever. |

## What's deliberately not here

- No tier hierarchy (fact / episode / milestone). Kioku stores flat atomic facts; `event_date` handles temporality.
- No daily/weekly/monthly merges. Better retrieval makes the compression strategy unnecessary.
- No importance scoring. Top-K hybrid ranking handles relevance on demand.
- No eager fact loading in the system prompt. Mashiro calls `searchMemory` when she needs context.
- No `noteToSelf` / working-memory scratchpad. In-conversation context plus on-demand recall covers it.
- No mood log / emotional baseline tracking.
- No UPDATE / DELETE on facts. Corrections happen by appending newer facts with later `event_date`; the answerer prompt resolves contradictions newest-wins (Kioku's `prompts/answer.md`).

## Observability

- `kioku ingest: starting` / `kioku ingest: done` / `kioku ingest: failed` — per-session ingest log lines from `@kokoro/memory`. The `done` line includes `sessionId`, `chatId`, `added`, `batches`, `failed`, `durationMs`; the `failed` line adds `attempts`, `ingestStatus`, and `countsTowardCap`. A total Kioku-side extraction failure (every batch errored) now returns 500, so it lands on the `failed` line and the session stays `pending` for the sweeper to retry — until it crosses `MAX_INGEST_ATTEMPTS`, after which it goes terminal `failed`. Previously the same case returned 200 with `added:0` and was marked `done`, orphaning the transcript.
- `kioku sweeper: pending ingest sweep finished` — per-tick summary `{scanned, reconciled, ingested, failed, abandoned}` (`abandoned` = sessions just driven to terminal `failed`).
- `kioku sweeper: closed stale active sessions` — fires when the active sweep closes anything.
- `Tool: searchMemory` / `Tool: rememberFact` — tool invocation log lines (info level). Watch the rate to detect prompt regressions where Mashiro stops calling memory.

## Related docs

- [ai-layer.md](ai-layer.md) — full tool palette + behavioral guidance
- [watchers.md](watchers.md) — read-only invariant (`searchMemory` allowed, `rememberFact` excluded)
- [architecture.md](architecture.md) — package boundaries, dependency graph
