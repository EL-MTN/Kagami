# Ingest

Ingest is the write path: turn conversation transcripts (or single caller-supplied facts) into rows in the `facts` and `entities` collections. All code lives under `apps/api/src/ingest/`, with `apps/api/src/storage/` as the persistence layer.

## Layout

```
apps/api/src/ingest/
├── transcript.ts        # gray-matter frontmatter + `## t-N <role>` heading parser
├── session-summary.ts   # cached narrative summary fed into the extraction prompt
├── consolidate.ts       # transcript → atomic facts (the core pipeline)
├── append.ts            # single-fact + bulk-infer=false add (mem0-OSS-style)
└── sessions.ts          # HTTP-shaped wrapper: parse + upsert transcript + consolidate
```

Two entry points are exposed to clients:

| Entry                     | Reaches                                       | When to use                                                                                          |
| ------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ingestSessionFromString` | `parseTranscript` → `consolidate` → summary   | A full transcript with frontmatter and `## t-N` turns. The MCP `ingest_session` tool and `POST /sessions`. |
| `appendSingleFact` / `appendFactsBulk` | direct write, no LLM extraction      | Caller already decided this is a fact worth keeping. The MCP `append_fact` / `append_facts` tools and `POST /facts`, `POST /facts/bulk`. |

## Transcript format (`transcript.ts`)

`parseTranscript(raw: string)` parses:

```
---
id: <session-id>
started_at: 2025-08-12T14:00:00Z
---

## t-0 user
Hi, I just got back from Berlin.

## t-1 assistant
How was the trip? Did you visit anyone?
```

- Frontmatter is YAML, validated by `TranscriptFrontmatter` (`{ id, started_at }`). `started_at` accepts a string or `Date` and normalizes to ISO.
- Turn headings match `^##\s+(t-\d+)\s+(\S+)\s*$`; the second capture is the role (`user`, `assistant`, or anything else — `consolidate` only treats the lowercase `user` specially).
- Body lines after a heading accumulate into `text` and are trimmed.

## Consolidation pipeline (`consolidate.ts`)

The core ingest. Constants:

| Constant                     | Value | Purpose                                                                       |
| ---------------------------- | ----- | ----------------------------------------------------------------------------- |
| `BATCH_SIZE`                 | 2     | Messages per extraction call (one user + one assistant turn).                  |
| `TOP_K_EXISTING`             | 10    | Cosine-nearest existing facts shown to the extractor as dedup context.        |
| `RECENTLY_EXTRACTED_LIMIT`   | 20    | Tail of in-run extracted facts also shown for cross-batch coherence.           |
| `LAST_K_MESSAGES`            | 20    | Conversation context preceding the batch, fed into the prompt.                 |

Per `consolidate(transcript, opts)`:

1. **Read scope-bound dedup context.** `readFactsInScope({ user_id, run_id, agent_id })`. Hash collisions and cosine-near-neighbors outside this tuple do not constrain extraction.
2. **Compute or read the rolling session summary.** `getOrComputeSessionSummary(...)` returns a 4–8 sentence narrative grounding entities and references for every batch. Cached in `session_summaries` keyed by `source_session` so a re-run on the same transcript reuses it.
3. **Track seen md5 hashes.** Seeded with `existing.map(hash)` so duplicates from a re-ingest never reach the writer.
4. **For each 2-message batch:**
   - Embed the concatenated batch text (`embed`, 15 s timeout).
   - Pick top-10 cosine-nearest from `existingFacts ∪ recentlyExtracted` as `existingMemories`.
   - Build the user prompt sections: Summary, Last k Messages, Recently Extracted, Existing Memories, New Messages, Observation Date, Current Date.
   - `generateObject(model, ExtractionResult)` against `prompts/extraction.md` — schema is `{ memory: [{ id, text, category }] }`. `temperature: 0`, 120 s timeout. The reasoning-to-content middleware in `llm.ts` salvages output for thinking-mode models that emit into `reasoning_content`.
   - For each extracted memory:
     - md5 hash of `text`. Skip if already in `seenHashes` (existing or earlier-in-run).
     - `normalizeCategory(raw)` clamps unknown values to `"misc"`.
   - `embedMany(survivors)` (30 s timeout) → embeddings.
   - Build `Fact` rows with `id = randomUUID()`, `created_at = now`, `event_date = sessionDate`, `source_session = "raw/<sessionId>"`.
   - `appendFacts(rows)` → `insertMany({ ordered: false })`. The `facts_hash_unique` index handles last-line dedup atomically. Audit events are recorded only for indices Mongo confirmed inserted.
   - `upsertEntitiesFromFacts(rows)` to keep the entity-boost ranker fed.
   - Append rows to `recentlyExtracted` so the next batch's cosine top-10 includes them.

Returns `{ added, batches }`.

### Categories

The extraction prompt asks the model to emit one of:

```
personal_details · family · professional_details · sports · travel · food
music · health · technology · hobbies · fashion · entertainment · milestones
user_preferences · misc
```

`normalizeCategory(raw)` lowercases + trims and falls back to `"misc"` for unknown values. `category` is required on the wire (OpenAI's strict json_schema mode rejects optional properties), but writers always have a usable value.

### Failure modes

- Embed call fails: log + `continue` (skip this batch). The next batch is independent.
- Extraction call fails: log + `continue`.
- Entity upsert fails: log + proceed. Facts are durable; entity boost is best-effort.
- Mongo `insertMany` errors with code `11000` (duplicate key) are tolerated — only confirmed-inserted indices generate audit events. Other write errors propagate.

## Single-fact append (`append.ts`)

`appendSingleFact(input)` and `appendFactsBulk(inputs)` (max 500). Bypasses the LLM extraction pipeline; the caller has already decided this is a fact worth keeping. Both serialize on a process-wide async lock (`withAppendLock`) so the cosine near-dupe check can't race with itself across concurrent calls.

```
NEAR_DUPE_COSINE = 0.97
```

Pipeline (`appendSingleFactImpl`):

1. Trim text; reject empty.
2. md5 hash. Read scope-bound facts. If a hash hit exists → return `{ status: "duplicate", reason: "hash" }` with the existing fact's id.
3. `embedQuestion(text)` (5 s timeout via `embed`).
4. Compute cosine against every in-scope existing fact. If `bestSim ≥ 0.97` → return `{ status: "duplicate", reason: "cosine", similarity }` with the near-dupe's id.
5. Build `Fact` with `event_date` defaulting to today, `source_session` defaulting to `""`.
6. `appendFacts([fact])` (audits ADD via `recordEvents`).
7. `upsertEntitiesFromFacts([fact])` (logged + tolerated on failure).
8. Return `{ id, status: "added" }`.

Bulk path runs the same impl in series under the lock and returns one result per input in order.

### Why the lock?

The hash check is race-safe via the unique index. The cosine check is not — two concurrent calls with byte-distinct but cosine-similar text would each see no near-dupe and both insert. `$vectorSearch` can't atomically guard insertion. The lock is narrow (single + bulk paths only); transcript ingest is unaffected.

## Session ingest (`sessions.ts`)

The HTTP-shaped wrapper. Hit by `POST /sessions` and the MCP `ingest_session` tool.

```
ingestSessionFromString({ transcript, user_id, run_id, agent_id, metadata })
  ├─ parseTranscript(transcript)
  ├─ upsertTranscript(parsed, scope)              ← transcripts collection (source-of-truth)
  ├─ consolidate(parsed, scope, metadata)         ← atomic facts
  └─ return { sessionId, added, batches }
```

The narrative session summary (4–8 sentences) generated by `generateNarrativeSummary` in `session-summary.ts` is a separate artifact: it lives in the `session_summaries` collection keyed by `source_session` and is fed into every batch's extraction prompt to ground entities and references. It is **not** stored as a fact. The previous "summary fact" (a keyword-rich clause persisted as `On <date>, conversation covered: <topics>.`) was removed — those clauses behaved as low-IDF retrieval noise that matched almost any query.

## Persistence

Writes flow through `apps/api/src/storage/`:

- `appendFacts(facts)` — `insertMany({ ordered: false })` against `facts`. Tolerates `code 11000` duplicates. Records ADD events via `recordEvents` only for confirmed inserts.
- `upsertTranscript(input)` — `updateOne(_id, $set, $setOnInsert: { created_at })` against `transcripts`. Re-ingest just refreshes `updated_at`.
- `upsertEntitiesFromFacts(facts)` — extracts proper-noun + quoted entities, `$setOnInsert` on new entities (with embedding), `$addToSet` on `linked_memory_ids`. Race-safe under concurrent ingest.
- `getOrComputeSessionSummary(...)` — read-then-upsert with `$setOnInsert`; first writer wins.

See [storage.md](storage.md) for the schema and indexes.
