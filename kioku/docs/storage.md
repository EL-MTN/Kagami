# Storage

All persistent state lives in a single MongoDB database. The default URI targets a local Atlas Search instance; the default DB name is `kioku`.

## Layout

```
apps/api/src/storage/
├── mongo.ts        # lazy MongoClient singleton + getDb()
├── indexes.ts      # idempotent btree + Atlas Search + vector index setup
├── facts.ts        # atomic facts collection
├── entities.ts     # entity store with linked_memory_ids
├── transcripts.ts  # parsed transcripts (source-of-truth for re-ingest)
└── history.ts      # audit log of fact ADD/UPDATE/DELETE events
```

The narrative session-summary collection (`session_summaries`) is owned by `apps/api/src/ingest/session-summary.ts`, not the storage module — it has no reads outside the ingest path.

## Mongo client (`mongo.ts`)

Lazy singleton. The client is constructed on the first `getDb()` call so import-time side effects don't force a connection in tests or scripts that only need module-scope code.

```ts
const DEFAULT_URI = "mongodb://127.0.0.1:27017/?directConnection=true";
const DEFAULT_DB  = "kioku";

KIOKU_MONGO_URI   // overrides DEFAULT_URI
KIOKU_MONGO_DB    // overrides DEFAULT_DB
```

Two concurrent first-callers join the same in-flight `connect()` Promise instead of each opening their own client. On connection failure, the cached promise is cleared so the next caller can retry.

`closeMongo()` is called from the SIGINT/SIGTERM handlers in `server.ts`.

## Collections

```
db: kioku  (atlas-local on 127.0.0.1:27017 by default)
├── facts               atomic facts: text + embedding + dates + md5 hash + scope
├── entities            entities: text + embedding + linked_memory_ids
├── transcripts         parsed session transcripts (source-of-truth for ingest)
├── session_summaries   cached narrative summaries, keyed by source_session
└── history             audit log of fact ADD/UPDATE/DELETE events
```

State lives entirely in Mongo — no filesystem-backed vault.

### `facts`

```
{
  _id:               <uuid>                  // Fact.id
  text:              string
  text_lemmatized?:  string                   // pre-lemmatized for BM25 (older rows may be missing)
  user_id:           string                   // 'default' if unspecified
  run_id?:           string
  agent_id?:         string
  created_at:        ISO timestamp            // ingestion time
  event_date:        YYYY-MM-DD               // session timestamp the fact was extracted from
  source_session:    string                   // e.g. "raw/answer_4be1b6b4_1" or caller-supplied
  hash:              md5(text)                // unique per scope
  embedding:         number[]                 // EMBEDDING_MODEL output dim
  metadata?:         Record<string, unknown>  // free-form; flat scalars are filterable, nested is stored but not indexed
  category?:         string                   // mem0-OSS category enum or 'misc'
}
```

#### Indexes (btree)

| Name                  | Key                                                  | Purpose                                                                                              |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `facts_hash_unique`   | `{ user_id: 1, run_id: 1, agent_id: 1, hash: 1 }` (unique) | md5 dedup, scoped by tenant tuple. Mongo treats absent fields as `null`, so legacy rows without `run_id`/`agent_id` still satisfy uniqueness within their `(default, null, null)` scope. |
| `facts_user_created`  | `{ user_id: 1, run_id: 1, agent_id: 1, created_at: -1 }`   | Read-side compound for scope-bound listings.                                                          |

`ensureIndexes()` drops legacy `{hash:1}` and `{user_id:1, created_at:-1}` shapes on first startup after the scope upgrade and recreates with the scoped versions.

#### Indexes (Atlas Search / vector)

`facts_vec` (`type: "vectorSearch"`):

```json
{
  "fields": [
    { "type": "vector",  "path": "embedding", "numDimensions": <probed>, "similarity": "cosine" },
    { "type": "filter",  "path": "user_id" },
    { "type": "filter",  "path": "run_id" },
    { "type": "filter",  "path": "agent_id" },
    { "type": "filter",  "path": "category" }
  ]
}
```

The `numDimensions` is probed at startup by calling `embedQuestion("probe")`. If the existing index dimension differs from the probed dimension, `ensureSearchIndex` raises a pointed error: "Did `EMBEDDING_MODEL` change? Drop the index … and restart." Atlas's `updateSearchIndex` rejects updates to vectorSearch indexes, so the additive-drift path drops + recreates (re-indexing rebuilds HNSW from existing docs — no data loss).

`facts_text` (`type: "search"`):

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "text_lemmatized": { "type": "string", "analyzer": "lucene.whitespace" },
      "user_id":         { "type": "token" },
      "run_id":          { "type": "token" },
      "agent_id":        { "type": "token" },
      "category":        { "type": "token" }
    }
  }
}
```

`lucene.whitespace` tokenizes on whitespace only — no re-stemming, no re-lowercasing — because `lemmatizeForBm25` already did all of that at write time. Same analyzer at search time means query tokens line up exactly with indexed tokens.

#### Reads

- `readFacts()` — full collection, sorted `(created_at asc, _id asc)`. Used by routes/facts list, MCP `fact_count`, and tests.
- `readFactsInScope({ user_id, run_id, agent_id })` — same sort; filters on the scope tuple. Used by ingest paths so dedup context stays scope-bound.

Embeddings are projected out by `routes/facts.ts::publicFact` on list/detail responses (768 floats × 4 bytes printed = ~10 KB per fact; only the ranker needs them).

#### Writes

- `appendFacts(facts, actor?)` — `insertMany({ ordered: false })`. Tolerates code-11000 duplicate-key errors. Records ADD events via `recordEvents` only for indices Mongo confirmed inserted (`insertedIds` keyed by input index — surviving partial-failure semantics).

### `entities`

```
{
  _id:               <uuid>
  text:              string         // display form (preserves original casing)
  text_lower:        string         // unique key for case-insensitive upsert
  entity_type:       'PROPER' | 'QUOTED'
  embedding:         number[]
  linked_memory_ids: string[]       // sorted/deduped via $addToSet
}
```

Entities are **not scoped** by `(user_id, run_id, agent_id)` — they're global by design. Scope filters applied on the fact path implicitly gate entity boosts because the boost map is intersected with the candidate-fact id set during ranking.

#### Indexes

| Name                          | Key             | Purpose                            |
| ----------------------------- | --------------- | ---------------------------------- |
| `entities_text_lower_unique`  | `{ text_lower: 1 }` (unique) | Case-insensitive upsert key |
| `entities_vec`                | vectorSearch on `embedding`  | Query-side entity matching  |

#### Writes

`upsertEntitiesFromFacts(facts)`:

1. For each fact, run `extractEntities(text)`. Build a per-key map `text_lower → { type, display, mems: Set<id> }`.
2. Read which keys already exist (`find({ text_lower: { $in: keys } })`).
3. Embed only new keys (existing rows already have embeddings).
4. For each new key: `updateOne({ text_lower }, { $setOnInsert: { _id, text, text_lower, type, embedding }, $addToSet: { linked_memory_ids: { $each: memIds } } }, { upsert: true })`.
5. For each existing key: `updateOne({ text_lower }, { $addToSet: { linked_memory_ids: { $each: memIds } } })`.

Race-safe under concurrent ingest: two writers touching the same entity converge on the union of their fact ids via `$addToSet`. A concurrent insert between the existence-probe and our upsert is still correct — our `$setOnInsert` is silently skipped (the embedding round-trip becomes wasted work; cheap).

### `transcripts`

```
{
  _id:         <sessionId>          // value of frontmatter.id
  user_id?:    string
  run_id?:     string
  agent_id?:   string
  started_at:  ISO timestamp        // from frontmatter
  turns:       Turn[]
  created_at:  ISO timestamp        // first ingest
  updated_at:  ISO timestamp        // latest upsert
}
```

Source-of-truth for the messages a session was extracted from. Re-ingest is filesystem-free: `consolidate()` reads from this collection and the existing facts pass; hash dedup short-circuits writes when nothing has changed.

`upsertTranscript(input)` uses `$set` for the body fields and `$setOnInsert: { created_at }` so subsequent re-ingests just refresh `updated_at`.

The `"raw/"` prefix in `Fact.source_session` is a vestigial namespace marker preserved for compatibility with existing rows; the `transcripts` collection stores the bare id.

### `session_summaries`

```
{
  _id:         <source_session>     // e.g. "raw/answer_4be1b6b4_1"
  user_id?:    string
  run_id?:     string
  agent_id?:   string
  summary:     string               // 4–8 sentence narrative
  turn_count:  number               // turns the summary was computed over
  created_at:  ISO timestamp
}
```

Owned by `apps/api/src/ingest/session-summary.ts`. The narrative summary is fed into the extraction prompt's `## Summary` slot; persisting it makes re-ingest free. Cache invalidation is `turn_count`-based — if the transcript grew, the summary is regenerated.

Writes use `updateOne(_id, { $setOnInsert: doc }, { upsert: true })` so a concurrent ingester that wrote first wins.

### `history`

```
{
  _id:         <uuid>
  memory_id:   <fact-id>
  event:       'ADD' | 'UPDATE' | 'DELETE'
  old_text?:   string
  new_text?:   string
  actor:       string               // 'system', 'consolidate', 'append', etc.
  created_at:  ISO timestamp
}
```

Modeled on mem0's history table. Every fact mutation leaves a row, capturing old + new text where applicable so a fact's evolution can be replayed.

| Event   | Required fields                |
| ------- | ------------------------------ |
| `ADD`   | `new_text`                     |
| `UPDATE`| `old_text`, `new_text`         |
| `DELETE`| `old_text`                     |

Today only `ADD` events are written (atomic facts are write-once). The `UPDATE` / `DELETE` shapes are reserved for future correction primitives.

#### Index

| Name                     | Key                                  | Purpose                                                                    |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------------------- |
| `history_memory_created` | `{ memory_id: 1, created_at: -1 }`   | Per-fact journal lookup is one cheap range scan.                           |

#### Reads / writes

- `recordEvent(input)` / `recordEvents(inputs)` — single + batch inserts. `appendFacts` uses the batch path.
- `readHistoryFor(memoryId)` — newest-first, projected through `fromDoc`. Used by `GET /facts/:id/history` and the MCP `fact_history` tool.

## `ensureIndexes()` (`indexes.ts`)

Idempotent. Safe to call on every startup — Mongo's `createIndex` and `createSearchIndex` are no-ops when an equivalent index already exists (matched by name).

Steps:

1. Build btree indexes (`ensureBtreeIndexes`):
   - Drop legacy `{hash:1}` if present, recreate scoped `facts_hash_unique`.
   - Drop legacy `{user_id:1, created_at:-1}` if present, recreate scoped `facts_user_created`.
   - Create `entities_text_lower_unique` and `history_memory_created` if missing.
   - The first `facts.indexes()` call may throw `NamespaceNotFound` (code 26) on fresh deployments — tolerated.
2. Build search + vector indexes (`ensureSearchAndVectorIndexes`):
   - Probe Atlas Search support via `$listSearchIndexes` **before** hitting the embedding provider. On vanilla mongo the probe throws and the outer catch swallows it (when `allowMissingSearch: true`), so we never make a needless embed call.
   - Probe embedding dimension via `embedQuestion("probe")`.
   - For each spec (`facts_vec`, `facts_text`, `entities_vec`):
     - Drift detection: existing `numDimensions` ≠ probed dim → throw with drop-and-restart instructions.
     - Drift detection: existing analyzer ≠ expected analyzer → throw.
     - Additive schema drift: missing filter/mapped fields → for `vectorSearch`, drop + recreate (Atlas rejects `updateSearchIndex` on vectorSearch); for `search`, `updateSearchIndex` in place.
     - Otherwise create.
   - Poll `$listSearchIndexes` until each reaches `READY` (180 s ceiling — empirically the ceiling under rapid bench cycles).

`EnsureIndexesOptions.allowMissingSearch` is `true` in the test harness so vanilla `mongodb-memory-server` (no Atlas Search) can run the btree-only paths.

## Operational notes

- **Local Atlas dev.** Run `atlas local start mongodb` or `docker run -d -p 27017:27017 mongodb/mongodb-atlas-local`. Vanilla MongoDB doesn't support `$vectorSearch` or `$search` — in production you need atlas-local (or full Atlas).
- **Embedding model swap.** Drop the affected vector indexes (`db.facts.dropSearchIndex("facts_vec")`, `db.entities.dropSearchIndex("entities_vec")`) and restart. `ensureIndexes()` will rebuild against the new dimension.
- **BM25 retune.** Empirical sigmoid params live in `getBm25Params` (`apps/api/src/retrieval/scoring.ts`). After significant corpus-shape changes, refit via `apps/api/scripts/probe-bm25-scores.ts`.
- **Index build time.** Atlas-local's `mongot` is slower than production Atlas. Rapid bench cycles (100 fresh DBs each needing fresh vector + search indexes) push past 60 s on a meaningful fraction of items; the polling timeout is 180 s.
