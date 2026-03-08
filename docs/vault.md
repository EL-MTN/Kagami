# Vault

The vault is a file-based Markdown store reserved for the **personality card only**. All dynamic memory (facts, milestones, episodes) is stored exclusively in MongoDB via the Memory Engine.

## Directory Layout

```
vault/
└── personality/
    └── card.md          # Character definition (loaded at startup)
```

## Frontmatter Schema

All vault files use YAML frontmatter parsed by `gray-matter`.

### personality/card.md

```yaml
---
name: <character name>
version: <number>
updated: <date>
---
```

Body contains the full character definition: appearance, identity, personality traits, communication style, interests, emotional range, relationship dynamic, boundaries, and tool usage guidelines.

## Vault Operations

Implemented in `src/memory/vault.ts`:

| Function | Description |
|---|---|
| `readVaultFile(path)` | Read file, parse frontmatter + content. Returns `null` on missing file. |
| `writeVaultFile(path, content, frontmatter)` | Write file with frontmatter. Creates parent dirs. |

All vault paths are resolved relative to `VAULT_PATH` and include a path traversal guard — any attempt to resolve a path outside the vault directory is blocked.

The LLM accesses the personality card through the `readMemory` tool (with `path` parameter).

## Memory Engine

All dynamic memory operations (facts, episodes, milestones, working memory) are handled by the Memory Engine (`src/memory/engine.ts`) backed by MongoDB. See [memory-management.md](memory-management.md) for full details.

### Embedding Service

Implemented in `src/memory/embedding.ts`. Uses Google Gemini `gemini-embedding-001` (3072 dimensions) via `@ai-sdk/google`.

| Function | Description |
|---|---|
| `generateEmbedding(text)` | Embed a single text string. Returns `number[3072]`. |
| `generateEmbeddings(texts)` | Batch embed multiple texts. Returns `number[][3072]`. |
| `cosineSimilarity(a, b)` | Re-exported from `ai` package. Returns `-1` to `1`. |

### Memory Model

Defined in `src/db/models/memory.ts`. Each document stores:

| Field | Type | Description |
|---|---|---|
| `content` | `string` | The actual text content |
| `type` | `"fact" \| "episode" \| "milestone" \| "working"` | Memory category |
| `source` | `string` | Origin: `"curation"`, `"session-curation"`, `"tool"`, `"weekly-merge"`, `"monthly-consolidation"` |
| `embedding` | `number[]` | 3072-dim vector (empty for working memory) |
| `metadata.chatId` | `string?` | Associated chat |
| `metadata.emotionalTone` | `number?` | 1-10 scale |
| `metadata.importance` | `number?` | 1-10 scale |
| `metadata.followUps` | `string[]?` | Unresolved action items |
| `metadata.createdAt` | `Date` | When the memory was created |
| `metadata.updatedAt` | `Date` | When the memory was last modified |
| `metadata.archivedAt` | `Date?` | Soft-archive timestamp (excluded from search) |
| `metadata.mergedInto` | `string?` | ObjectId of merge target |
| `metadata.sessionId` | `string?` | Links to the session that created it |
| `metadata.expiresAt` | `Date?` | TTL for working memory (MongoDB auto-deletes) |

### Engine API

Implemented in `src/memory/engine.ts`:

| Function | Description |
|---|---|
| `remember(content, type, source, opts?)` | Embed content, store in MongoDB. Returns the created document. |
| `recall(query, opts?)` | Tiered semantic search (90d then 365d). Composite scoring with 200-candidate cap. |
| `forget(memoryId)` | Hard delete a memory by ID. Used for fact UPDATE/DELETE. |
| `getRecentDailyEpisodes(limit?)` | Daily episodes only (excludes weekly/monthly merges, archived). |
| `getRecentWeeklyEpisodes(limit?)` | Weekly merge episodes only (excludes archived). |
| `getEpisodesBefore(olderThan, excludeSources?)` | Episodes older than a date (excludes archived). |
| `getTopFacts(limit?)` | Top N facts by importance (excludes archived). |
| `getFactsByRelevance(query, limit?)` | Semantic search scoped to facts (excludes archived). |
| `getFactCount()` | Count of active (non-archived) facts. |
| `getRecentMilestones(limit?)` | Recent milestones (excludes archived). |
| `getActiveFollowUps(limit?, maxAgeDays?)` | Follow-ups with 30-day age limit and dedup. |
| `resolveFollowUp(memoryId, text)` | Remove a specific follow-up from a memory. |
| `setWorkingMemory(content, sessionId, ttlHours?)` | Store session-scoped note with TTL. |
| `getWorkingMemories(sessionId)` | Get all working memories for a session. |
| `clearWorkingMemories(sessionId)` | Delete all working memories for a session. |
| `archiveMemory(memoryId, mergedIntoId?)` | Soft-archive a single memory. |
| `archiveMany(memoryIds, mergedIntoId?)` | Soft-archive multiple memories (batch). |
| `getEmotionalBaseline(windowSize?)` | Rolling emotional trend from non-archived episodes. |

## Curation Pipeline

Implemented in `src/memory/curator.ts`. The pipeline is **non-blocking** — curation runs as fire-and-forget with per-chat mutex protection.

### Overflow curation
Triggered when a conversation reaches 80 messages (40-message context window + 40-message curation batch).

### Session-end curation
Triggered when `getOrCreateSession` detects and closes a stale session (>1h idle). Short sessions (<5 messages) get a lightweight summary.

### Fact management
Uses bounded retrieval: only the 30 most relevant facts (by semantic similarity) are sent to the LLM for ADD/UPDATE/DELETE classification, with a note about total count if there are more.

### Merges (decoupled)
Weekly and monthly merges run on the proactive scheduler only (decoupled from curation). They use non-destructive archival instead of hard deletion.

## System Prompt Assembly

See [ai-layer.md](ai-layer.md) for the context assembly pipeline.
