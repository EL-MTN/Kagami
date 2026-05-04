# Plan: Delegate Kokoro Memory to Kioku

## Goal

Replace Kokoro's in-house memory engine with [Kioku](../Kioku) for all factual and episodic recall. Keep deterministic state (reminders, follow-ups, sessions) in Mongo. Shrink the system prompt; let the LLM retrieve on demand.

Motivation: Kokoro's memory is unreliable in practice. The tier system (daily → weekly → monthly merge) is a compression strategy that exists because retrieval is weak. Kioku's hybrid retrieval (cosine + BM25 + entity boost, 78% on LongMemEval-Oracle) makes the compression unnecessary — just store more facts and let `event_date` handle temporality.

## End-state architecture

```
Kokoro
├── Kioku (vault)
│   ├── facts.jsonl       ← all facts + flattened episodes + flattened milestones
│   ├── entities.jsonl    ← entity index for retrieval boost
│   └── _core.md          ← hand-maintained anchor facts
│
├── MongoDB (deterministic state only)
│   ├── conversations     ← session lifecycle, raw messages (unchanged)
│   ├── reminders         ← unchanged
│   ├── followups         ← NEW small state table; replaces follow-up subset of memories
│   ├── mood_log          ← NEW tiny rolling log (or delete; see open questions)
│   └── memories          ← DELETED after migration
│
└── soul.md               ← unchanged static personality
```

## Integration model

**Kioku runs as a standalone REST service.** Kokoro talks to it over plain HTTP. Kioku owns its own process, its own vault, its own deployment; Kokoro and the dashboard are clients.

- **Transport: REST.** No auth (local-only). The existing stdio MCP server stays as a separate entry point for hand-driven use; HTTP is the production surface.
- **Kokoro-side surface:** the LLM keeps its existing tools (`searchMemory`, `rememberFact`, etc.). Their implementations move into `apps/bot/src/memory-client/`, which is the only Kokoro module that knows Kioku exists. The LLM contract is unchanged; the implementation underneath swaps.

## Vault topology and deployment

**One vault, owned by Kioku.** Vault lives wherever Kioku is deployed; Kokoro never touches `facts.jsonl` directly. Cross-platform recall (Telegram ↔ iMessage) is a feature.

Both Kokoro and Kioku run locally. Kioku runs under [Portless](https://github.com/vercel-labs/portless) (same setup as the dashboard) so it gets a stable HTTPS URL like `https://kioku.localhost`. Kokoro's bot points `KIOKU_URL` at it.

If service-specific vaults are needed later, it's just another Kioku instance with another Portless host — `KIOKU_URL` becomes per-service.

## Component-by-component

### Facts → Kioku

Direct port. Kokoro's `engine.remember(content, "fact", ...)` becomes Kioku's append path. `rememberFact` tool calls `consolidate()` (or a thinner per-fact write API we add to Kioku).

UPDATE/DELETE semantics: Kioku is write-once. Newer facts with later `event_date` shadow older ones at retrieval time (this is how Mem0 handles it too). Acceptable. If a contradiction must be erased — rare — we hand-edit `_core.md` or extend Kioku with a tombstone.

### Episodes → Kioku extraction + summary fact

At session close (and on overflow), Kokoro POSTs the raw transcript to a Kioku endpoint that runs **both**:

1. **Atomic fact extraction** (existing `consolidate()` pipeline) — produces N atomic facts.
2. **Session summary fact** — Kioku generates one rolled-up fact: `"On <date>, conversation covered <topics>."`

Both with `event_date = session date`, `source_session = session id`. Kokoro's curator becomes a thin trigger; Kioku owns prompt design, dedup, and embedding.

No more daily/weekly/monthly tiers. No more soft-archival.

### Milestones → emergent

Stop emitting milestones explicitly. If a relationship-level pattern matters, it'll be retrieved as a high-scoring atomic fact. If we later see a gap, add a Kioku endpoint that asks the extraction LLM "is this a relationship-shift moment?" — but don't preempt it.

### Reminders — unchanged

Already deterministic Mongo state. Out of scope.

### Follow-ups → small Mongo state table

Follow-ups have an explicit lifecycle (open → resolved) and a 30-day TTL. They're not facts. New collection:

```ts
FollowUp {
  chatId, text, createdAt, resolvedAt?, sourceSessionId
}
```

Curator writes them at session close. Resolution still done by LLM classification at next session start. Replaces `metadata.followUps` on memories.

### Working memory (`noteToSelf`) — delete

Tool removed. In-conversation context plus on-demand `searchMemory` covers it.

### Emotional baseline — drop

Removed entirely. No `mood_log` collection. `getEmotionalBaseline()` and the trend injection in `assembleSystemPrompt` are deleted.

### Importance scoring — gone

Currently used to pick top-30 facts for eager prompt assembly. With on-demand retrieval that ranking is irrelevant. No replacement needed.

### soul.md — unchanged

Static. Already loaded directly by `assembleSystemPrompt`.

## Code changes

### Delete or gut

- `packages/memory/` — entire package goes away after migration. `engine.ts` (447 lines), `embedding.ts` (14 lines), `index.ts`.
- `packages/db/src/models/memory.ts` — delete after migration completes.
- `apps/bot/src/memory/curator.ts` — keep file, but strip:
  - Weekly merge (`checkWeeklyMerge`, ~40 lines)
  - Monthly consolidation (`checkMonthlyConsolidation`, ~40 lines)
  - Soft-archival logic
  - Importance scoring
  - `updateUserFacts` ADD/UPDATE/DELETE pipeline → replace with Kioku fact append
- `apps/bot/src/scheduler/proactive.ts` — remove `checkWeeklyMerge` / `checkMonthlyConsolidation` calls.

### Rewrite

- `apps/bot/src/ai/context-assembler.ts` — drastically shrunk. New shape:
  ```
  soul.md
  + active reminders
  + active follow-ups
  + _core.md (Kioku, optional anchor facts)
  + emotional baseline (if kept)
  ```
  No more eager top-30 facts, no more episode digests, no more milestones in prompt.
- `apps/bot/src/ai/tools/memory.ts` — tools become thin wrappers over Kioku:
  - `searchMemory(query)` → Kioku `query()` (returns answer + citations) **or** a new `recall()` API on Kioku that returns ranked facts directly. Need the latter; current `query()` runs an LLM over results, which is wrong for tool-use.
  - `rememberFact(content)` → Kioku fact append (need to add a single-fact API to Kioku; current `consolidate()` is transcript-batch oriented).
  - `listMemories`, `readMemory` — implement against `facts.jsonl`.
  - `noteToSelf` — delete or repurpose.

### Add

- `apps/bot/src/memory-client/` — typed `fetch` wrapper around Kioku's REST API. Functions: `recall`, `appendFact`, `getFactById`, `getFactCount`, `ingestSession`. The only Kokoro module that knows Kioku exists.
- `packages/db/src/models/followUp.ts` — new collection.
- Migration script `scripts/migrate-to-kioku.ts` — see below.
- Env var: `KIOKU_URL`.

### Kioku-side changes (the bulk of the upstream work)

- **HTTP server (Hono).** Lightweight, fits AI SDK ecosystem, easy Portless wiring. Long-lived process with graceful shutdown and a health endpoint. No auth.
- **Routes:**
  - `POST /facts` — single-fact append. Runs embed + dedup-against-top-10 + entity extraction inline.
  - `POST /recall` — ranked retrieval, no LLM. Returns `{facts: [{id, text, event_date, source_session, score}], total}`. Filters: `query` (required), `k` (default 10), `minScore`, `since`, `until`.
  - `POST /query` — existing answer-with-LLM path, kept for the dashboard's "ask the vault" use case.
  - `POST /sessions` — accepts a transcript blob, runs full extraction (atomic facts) **and** generates one session-summary fact. Returns `{addedFactIds: [...], summaryFactId}`.
  - `GET /facts/:id`, `GET /facts` (paginated list), `GET /facts/count`, `GET /health`, `GET /version`.
- **Embedding provider.** New default chosen inside Kioku (likely OpenAI `text-embedding-3-small` for speed + quality, but final call lives in the Kioku repo). All migrated content gets re-embedded; existing Kokoro vectors are discarded.
- **Portless config.** Kioku gets its own `portless.config` so it runs at `https://kioku.localhost`.
- **Logs.** Structured request logs (Pino, matching Kokoro convention).

## Data migration

One-shot script reads all docs from `Memory` collection and POSTs them to Kioku (which re-embeds with its configured model). Existing embeddings are discarded.

| Mongo doc                 | Kioku call                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `type: fact`              | `POST /facts` with `{text: content, event_date: createdAt, source_session: source}`                                      |
| `type: episode`           | `POST /facts` with `{text: "On <date>, conversation covered: <content>", event_date: createdAt, source_session: source}` |
| `type: milestone`         | `POST /facts` with `{text: "Relationship milestone: <content>", event_date: createdAt, source_session: source}`          |
| `type: working`           | skip                                                                                                                     |
| `metadata.archivedAt` set | skip (already merged into survivor)                                                                                      |
| `metadata.followUps`      | extract → new `followups` collection                                                                                     |

Backups: snapshot the `memories` collection before migration. Leave the Mongo collection in place for one release cycle so we can verify before deletion.

## Phased rollout

1. **Kioku as a service.** Add HTTP server, single-fact append, ranked recall, auth, health, version. Tag a Kioku release. Stand up locally; smoke test with `curl`.
2. **Kokoro memory-client.** Build `apps/bot/src/memory-client/` against the running Kioku. No Kokoro-side wiring yet — just a tested client module.
3. **Wire-up branch.** Replace tool implementations and context-assembler to call the client. Old memory engine still in place but unused. Optional shadow mode: each `searchMemory` call hits both old and new, log diffs.
4. **Migration dry-run.** Script with `--dry-run` flag; eyeball output for a sample of facts/episodes.
5. **Cut over.** Run migration, flip the bot to read from Kioku, leave old `memories` collection untouched as a backup.
6. **Soak.** One week. Watch dashboard observability (the dashboard is now the second Kioku client — confirm its reads are migrated too).
7. **Cleanup.** Delete `packages/memory`, `Memory` model, dead curator code, old tests. Update `docs/memory-management.md` (or replace with `docs/kioku.md`).

## Open questions (remaining)

1. **Dashboard observability.** Today the dashboard reads Mongo `memories` directly. Under the new model it becomes a Kioku HTTP client. Likely needs `GET /facts?limit=...&since=...` plus existing endpoints. Wire-up details deferred until phase 6.
2. **Concurrent-write safety in Kioku.** Today's `consolidate()` is single-shot CLI; running as a long-lived service means multiple in-flight `POST /facts` calls could race on `facts.jsonl` append. Need a write mutex inside Kioku.

## What we explicitly are NOT doing

- Not importing Kioku as a library or workspace package. It's a service.
- Not building Kioku's hybrid retrieval into Kokoro in-place (the earlier "option 1/2" path).
- Not maintaining tier hierarchy or merge logic.
- Not preserving `Memory` collection long-term.
- Not extending Kioku to a multi-user system at the data layer — multi-tenancy is solved by running multiple Kioku instances if ever needed.
- Not switching the embedding provider away from Google unless re-embed migration forces a choice.
