# MongoDB Migration Plan

Move Kioku's storage from JSONL files + in-process retrieval to MongoDB Community 8.2 with `mongot` (via `mongodb/mongodb-atlas-local` container on `127.0.0.1:27017`). Goal: closer parity with mem0's three-backend architecture (Qdrant + SQLite + history) collapsed into one Mongo instance, with hybrid retrieval running server-side.

Bench gate: must hold ≥76% on the 100-item LongMemEval-Oracle subset after migration.

## Why this is worth doing

Three concrete gaps in current Kioku that Mongo + mongot closes:

1. **Recall ceiling.** BM25 only runs over the cosine-top-K window (`max(k*4, 60)`). A query whose true match has weak cosine but strong keyword overlap is missed. mem0 stores BM25 sparse vectors alongside dense ones in Qdrant for whole-corpus hybrid; Mongo's `$rankFusion` (or `$search` + `$vectorSearch` fan-out) gets us the same property.
2. **No audit log.** `rewriteFacts` discards prior text with no trace. mem0 has a SQLite `history` table recording every ADD/UPDATE/DELETE with old/new text. Need an equivalent.
3. **Linear cosine scan.** Fine through ~10K facts; HNSW gets us to 100K+ if/when needed.

Things we are **not** changing: the data model (atomic facts + entities with linked_memory_ids), the extraction prompt, the answerer prompt, the additive scoring weights (1.0 dense + 1.0 BM25 + 0.5 entity), `_core.md` policy (still ignored), the MCP tool surface.

## Target architecture

```
Mongo replica set (atlas-local container, port 27017)
  db: kioku
    collection: facts
      schema: { _id, text, text_lemmatized, user_id, created_at,
                event_date, source_session, hash, embedding[] }
      indexes:
        - dense vector index "facts_vec" on embedding (cosine, dim from env)
        - $search index "facts_text" on text_lemmatized (Lucene/BM25)
        - btree on hash (dedup lookup)
        - btree on { user_id: 1, created_at: -1 } (filter + sort)
    collection: entities
      schema: { _id, text, text_lower, entity_type, embedding,
                linked_memory_ids[] }
      indexes:
        - dense vector index "entities_vec" on embedding (cosine)
        - unique btree on text_lower (case-insensitive upsert key)
    collection: history
      schema: { _id, memory_id, event ('ADD'|'UPDATE'|'DELETE'),
                old_text?, new_text?, actor, created_at }
      indexes:
        - btree on { memory_id: 1, created_at: -1 }
```

`hash` stays as a fast md5 dedup gate before any vector work — Mongo unique index makes this `O(1)` instead of the JSONL load-and-scan we do today.

## Phasing

Each phase is one PR, leaves the project in a working state, and is independently revertible.

### Phase 1 — connection layer

- Add `mongodb` driver + `@types/mongodb` (or use the bundled types).
- New `src/storage/mongo.ts`: lazy `MongoClient` singleton, `getDb()` returning `Db`. Connection string from `KIOKU_MONGO_URI` (default `mongodb://127.0.0.1:27017/?directConnection=true`), DB name from `KIOKU_MONGO_DB` (default `kioku`).
- `src/server.ts`: graceful shutdown closes the client.
- New `src/storage/indexes.ts`: idempotent `ensureIndexes()` that creates btree + vector + search indexes on startup. Polls `$listSearchIndexes` until each search index is `READY` (indexes are async).
- `.env.example` updated. README wiring section updated.
- Test: integration test that boots an in-process MongoMemoryReplSet (`mongodb-memory-server` with `replSet: true`) and verifies `ensureIndexes()` is idempotent.

No production code switches backends in this phase — Mongo is only contacted at startup.

### Phase 2 — storage rewrite (facts)

- Reimplement `src/storage/facts.ts` against Mongo. Same exported API: `readFacts`, `appendFacts`, `rewriteFacts`, `Fact` type, `newFactId`. `readFacts` keeps loading the whole collection into memory for now — the retrieval rewrite in Phase 4 is what removes that.
- Drop the JSONL fallback. `paths.facts` is no longer referenced (delete the entry from `paths.ts`).
- `appendFacts` does an `insertMany` with the md5 hash unique index doing the dedup work.
- `rewriteFacts` becomes `bulkWrite` upserts — but more importantly, every overwrite emits a `history` record (Phase 6 wires this through; for now, leave a TODO).
- Update `tests/facts.test.ts` to use `mongodb-memory-server` instead of tmpdir + JSONL fixtures.
- Bench gate: re-run a 10-item smoke pass to confirm ingest + query end-to-end still works.

### Phase 3 — storage rewrite (entities)

- Reimplement `src/storage/entities.ts` against Mongo. Same exported API: `readEntities`, `writeEntities`, `upsertEntitiesFromFacts`.
- The atomic upsert pattern (`text_lower` unique index + `$addToSet` on `linked_memory_ids`) replaces the current "read everything, merge in memory, rewrite the file" pattern. This is a real improvement — concurrent ingests stop racing.
- `writeEntities` becomes a no-op or is removed; callers shouldn't bulk-replace anymore.

### Phase 4 — retrieval rewrite

The interesting one. Two implementation options for hybrid retrieval; pick **A** unless bench parity fails.

**Option A — keep additive fusion, fan out client-side.** Mirror current behavior exactly:
1. `$vectorSearch` on `facts_vec` with `numCandidates: max(k*4, 60) * 10`, `limit: max(k*4, 60)` → top dense candidates with `vectorSearchScore`.
2. `$search` on `facts_text` filtered to those candidate `_id`s → BM25 raw scores. Apply our existing query-length-adaptive sigmoid (`getBm25Params`, `normalizeBm25`) in app code.
3. Entity boost as today (`computeEntityBoosts`) — query entities → `$vectorSearch` on `entities_vec` → boost linked facts.
4. Existing `scoreAndRank` in `src/retrieval/scoring.ts` runs unchanged — same weights (1.0 + 1.0 + 0.5), same `max_possible` denominator, same threshold gate.

**Option B — `$rankFusion` (RRF, server-side).** One aggregation does dense + BM25 fusion. Simpler code, but RRF ≠ our additive scoring, so this WILL change retrieval order vs both Kioku-today and mem0. Only adopt if A's bench number drops.

In either case:
- `src/retrieval/embeddings.ts` no longer loads all facts. The cosine pre-pass moves into Mongo's `$vectorSearch`.
- `src/retrieval/bm25.ts` is deleted — the in-process Okapi index is dead. `getBm25Params` and `normalizeBm25` from `scoring.ts` stay.
- `lemmatizeForBm25` now also runs at write time on `appendFacts` so `text_lemmatized` is queryable by `$search`.

**Recall implication to verify:** today BM25 only sees `max(k*4, 60)` cosine-prefiltered facts. With `$search` over the whole collection (Option A or B), facts that are weak on cosine but strong on keyword now have a path to enter the top-K. This is a behavior change vs current Kioku, and **closer to mem0**, so bench should hold or improve. If it regresses, we have a real signal worth investigating.

### Phase 5 — drop the mutex

`src/mutex.ts` exists because JSONL append + entity rewrite race when two ingests overlap. Mongo's per-document atomicity + the `text_lower` unique index handle this. Remove the mutex, remove all callers. Add a stress test: 10 parallel `consolidate()` calls on the same transcript, assert the resulting fact set matches the serial outcome.

### Phase 6 — history collection

- New `src/storage/history.ts` with a single `recordEvent({memory_id, event, old_text?, new_text?, actor})` function.
- Wire from every fact mutation: `appendFacts` → ADD events; `rewriteFacts` → UPDATE/DELETE events with old text captured before the write.
- New REST route `GET /facts/:id/history` returns the journal for one fact.
- New MCP tool `fact_history` (matches the existing tool surface).

### Phase 7 — importer

One-shot script `scripts/import-jsonl.ts` for users with an existing vault. Reads `$KIOKU_VAULT/.memory/facts.jsonl` and `entities.jsonl`, writes to Mongo with `--dry-run` and `--batch-size` flags. Emits a summary (`{factsImported, entitiesImported, duplicatesSkipped}`). Idempotent via the `hash` unique index.

This phase ships *after* Phase 4 so that fresh-install users aren't blocked on it.

### Phase 8 — bench parity

Re-run `bench/longmemeval` end-to-end on the 100-item Oracle subset.

- Pass: ≥76% (current Kioku baseline). Done.
- Marginal regression (74-75%): investigate per-type breakdown. Likely culprit is `$search` analyzer differences vs our hand-rolled lemmatizer — check that index analyzer matches `lemmatizeForBm25`.
- Material regression (<74%): switch from Option A to Option B, or fall back to Phase-4 Option A with `$search` filtered to candidates (current behavior, just re-implemented on Mongo).

The bench worker (`scripts/longmemeval-worker.ts`) currently uses `KIOKU_VAULT` for isolation. With Mongo, isolation switches to per-item DB names: each worker gets `kioku_bench_<item_id>` and drops it on teardown. `KIOKU_VAULT` still needed for `raw/<session>.md` transcript writes during ingest.

### Phase 9 — operational cleanup

- README rewrite: storage section, env var list (`KIOKU_VAULT` becomes optional / transcript-only; `KIOKU_MONGO_URI` is required), prerequisites mention the atlas-local container.
- Container boot order in dev: `atlas local start mongodb` → `npm start`. Add a friendly error on connection failure that points at this.
- Remove dead JSONL fixture files from `tests/`.
- Delete `src/paths.ts` entries for `facts`, `entities`, `internal`, `llmFailures` (only `vault`, `raw`, `prompts` remain).

## Open questions to resolve before Phase 4

1. **Embedding dimension.** Currently inferred at write time from the provider's response. The Mongo vector index needs a fixed `numDimensions` at creation. Either: (a) require an env var `KIOKU_EMBEDDING_DIM` and fail on mismatch, or (b) defer index creation until the first `appendFacts` call and read dim from the first row. (a) is simpler and forces the user to make a deliberate choice; (b) is more magical but means startup health checks can't validate the index exists.

2. **Search index analyzer.** `$search` defaults to the `lucene.standard` analyzer. Our `lemmatizeForBm25` does aggressive lemmatization. Mismatch will hurt BM25 recall. Options: pre-lemmatize at write time (already planned) and use a `lucene.keyword` analyzer that doesn't re-tokenize, OR ship the raw text and rely on a `lucene.english` analyzer with stemming (closer to upstream defaults but harder to reason about). Pick at start of Phase 4.

3. **Entity boost via `$search`?** Today entity matching is cosine over the entity store. We could also `$search` the entity collection by text — would catch lexical matches the embedding model misses. Defer to a follow-up; not in scope for this migration.

4. **Per-user scoping.** Schema supports `user_id` filtering but no current code uses it. Defer.

## Rollback

Each phase is one PR. If Phase N regresses, revert that PR. Phases 1–3 leave the JSONL data dir untouched; the importer in Phase 7 doesn't delete source files. The only hard cutover point is Phase 9 (paths.ts entries removed) — until then, a revert is mechanically clean.
