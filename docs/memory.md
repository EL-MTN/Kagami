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
  index.ts         typed fetch wrapper around Kioku's REST API
  transcript.ts    IConversation → Kioku transcript markdown
  ingest.ts        ingestClosedSession (fire-and-forget) + ingestClosedSessionAwaited
  sweeper.ts       sweepPendingIngests + sweepStaleActiveSessions
```

`apps/bot/src/ai/tools/memory.ts` — AI SDK tool factories (`searchMemory`, `rememberFact`).

## Configuration

| Env var     | Default                 | Purpose                                                |
| ----------- | ----------------------- | ------------------------------------------------------ |
| `KIOKU_URL` | `http://localhost:7777` | Kioku service base URL. Validated as a URL at startup. |

Run Kioku locally per its README. Under [Portless](https://github.com/vercel-labs/portless) you can point `KIOKU_URL` at a stable HTTPS host like `https://kioku.localhost`.

## Read paths

### `searchMemory` tool (LLM-driven, on demand)

The dominant read path. Mashiro calls it whenever past context would help. Available in:

- `allTools(ctx)` — main conversational and proactive flows
- `watcherTools(ctx)` — watchers can read but never write

Forwards to `@kokoro/memory.recall()` → `POST /recall`. Kioku ranks via cosine + BM25 + entity boost and returns top-K facts. Default `k = 8`. Optional `since` / `until` clamp `event_date`.

**Fail-open:** on Kioku outage the tool returns `{success: false, degraded: true, facts: []}` so the LLM keeps responding instead of stalling.

### Sweeper probe

Before re-ingesting a `pending` session, the sweeper calls `hasFactsForSession(sourceSession)` to check if Kioku already has facts tagged with that session. If so, it just marks `done` instead of re-ingesting (avoids paraphrased duplicates from extraction-LLM variance).

### External MCP clients

Kioku also exposes `recall`, `query` (with answerer LLM), `view` (vault files), and `fact_count` over its `/mcp` endpoint. Out of scope here; see Kioku's docs.

## Write paths

### Automatic — session-close transcript ingest

When `getOrCreateSession` rolls over a stale session (>1h idle) and a new message arrives, the closed conversation is shipped to Kioku for fact extraction. Four call sites pick up the `previouslyClosed` return:

- `apps/bot/src/ai/generate.ts` — every inbound user message
- `apps/bot/src/ai/acknowledge.ts` — confirmation acknowledgments
- `apps/bot/src/scheduler/proactive.ts` — proactive messages
- `apps/bot/src/services/confirmation-events.ts` — when a tap-to-approve resolves

Each calls `ingestClosedSession(convo)` — fire-and-forget. The new turn doesn't wait. On success the conversation's `ingestStatus` flips `pending → done` and `ingestedAt` is recorded.

### Sweeper-driven (correctness layer)

Every 5 minutes the proactive scheduler runs both sweepers:

- **`sweepPendingIngests`** — finds `{closed && (ingestStatus pending or absent) && closedAt < now-60s}`, probes Kioku for existing facts via `hasFactsForSession`, ingests if absent. Catches anything that failed the immediate trigger. Matches legacy documents that pre-date the `ingestStatus` field.
- **`sweepStaleActiveSessions`** — finds `{active && updatedAt < now-6h}`, closes them, marks `ingestStatus: "pending"`. The next pending sweep ingests them. Catches sessions where the user idled for days and never returned.

A one-shot run also fires 30s after process start so a fresh boot recovers anything that was pending when the previous process died.

The trigger is the latency optimization; the sweeper is the correctness layer. If the trigger ever misses (Kioku down, future fifth call site, manual `closeSession`, crash mid-trigger), the sweeper recovers within minutes.

### LLM-driven — `rememberFact` tool

When Mashiro decides a fact is worth keeping across sessions, she calls `rememberFact(text, eventDate?)`. Forwards to `@kokoro/memory.appendFact()` → `POST /facts`. Kioku does md5 + cosine ≥0.97 dedup, embeds, lemmatizes, and upserts entities. Idempotent — calling twice with the same text returns `{status: "duplicate", reason: "hash"}` with the existing id. Available in conversational paths; **excluded from watcher contexts** (watchers are read-only).

### Place-learning (passive)

`apps/bot/src/services/location.ts:learnPlace` watches for frequent visits: 3+ stored locations within 200m / 30 days. When the threshold trips, it calls `appendFact` with `"User frequently visits {placeName} ({placeCategory})."` Format is stable so md5 dedup catches re-saves.

## Conversation schema

`IConversation` (in `@kokoro/db`) has three new fields tracking the ingest lifecycle:

| Field            | Type                    | Default     | Purpose                                                   |
| ---------------- | ----------------------- | ----------- | --------------------------------------------------------- |
| `ingestStatus`   | `"pending"` \| `"done"` | `"pending"` | Lifecycle of session-close ingest. Sweeper drives → done. |
| `ingestedAt`     | `Date?`                 | —           | Timestamp when Kioku confirmed extraction.                |
| `ingestAttempts` | `number`                | `0`         | Bumped on each failed attempt (observability).            |

Indexed by `{ status, ingestStatus, closedAt }` for the sweeper query.

## Failure modes and recovery

| Failure                                       | Recovery                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Kioku unreachable on session rollover         | Trigger throws but is caught internally; `ingestStatus` stays `pending`. Sweeper retries in ≤5 min. |
| Crash mid-trigger before status update        | Same as above. Sweeper probes Kioku first; if facts already landed, just flips status to `done`.    |
| User idles for days; session never rolls over | `sweepStaleActiveSessions` closes after 6h. Next pending sweep ingests.                             |
| Legacy session pre-dates `ingestStatus` field | Pending-sweep query matches `{ ingestStatus: { $exists: false } }` too.                             |
| LLM extraction text drifts on retry           | Pre-ingest probe via `hasFactsForSession` skips re-ingest if any facts already match the session.   |
| Kioku returns 5xx on `searchMemory`           | `searchMemory` returns `{degraded: true, facts: []}`. Bot responds without memory context.          |

## What's deliberately not here

- No tier hierarchy (fact / episode / milestone). Kioku stores flat atomic facts; `event_date` handles temporality.
- No daily/weekly/monthly merges. Better retrieval makes the compression strategy unnecessary.
- No importance scoring. Top-K hybrid ranking handles relevance on demand.
- No eager fact loading in the system prompt. Mashiro calls `searchMemory` when she needs context.
- No `noteToSelf` / working-memory scratchpad. In-conversation context plus on-demand recall covers it.
- No mood log / emotional baseline tracking.
- No UPDATE / DELETE on facts. Corrections happen by appending newer facts with later `event_date`; the answerer prompt resolves contradictions newest-wins (Kioku's `prompts/answer.md`).

## Observability

- `kioku ingest: starting` / `kioku ingest: done` / `kioku ingest: failed` — per-session ingest log lines from `@kokoro/memory`. Includes `sessionId`, `chatId`, `added`, `batches`, `summaryFactId`, `durationMs`.
- `kioku sweeper: pending ingest sweep finished` — per-tick summary `{scanned, reconciled, ingested, failed}`.
- `kioku sweeper: closed stale active sessions` — fires when the active sweep closes anything.
- `Tool: searchMemory` / `Tool: rememberFact` — tool invocation log lines (info level). Watch the rate to detect prompt regressions where Mashiro stops calling memory.

## Related docs

- [ai-layer.md](ai-layer.md) — full tool palette + behavioral guidance
- [watchers.md](watchers.md) — read-only invariant (`searchMemory` allowed, `rememberFact` excluded)
- [architecture.md](architecture.md) — package boundaries, dependency graph
