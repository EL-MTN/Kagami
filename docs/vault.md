# Vault & Memory System

The memory system has two storage layers that stay in sync:

- **Vault** — file-based Markdown store with YAML frontmatter. Human-readable and editable. Holds personality definition, user facts, relationship milestones, and conversation summaries.
- **Memory Engine** — MongoDB-backed collection with vector embeddings. Enables semantic search, auto-injection of recent context, and structured fact management (ADD/UPDATE/DELETE).

## Directory Layout

```
vault/
├── personality/
│   └── card.md                          # Character definition (loaded at startup)
└── memories/
    ├── about-you.md                     # User facts (auto-updated by curator)
    ├── milestones.md                    # Relationship milestones
    └── conversations/
        ├── 2026-02-22T17-19-40.md       # Daily conversation summaries
        ├── 2026-02-22T17-39-58.md
        └── week-of-2026-02-15.md        # Weekly rollups
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

### memories/about-you.md

```yaml
---
type: "user-facts"
factCount: <number>
lastUpdated: <ISO8601 timestamp>
---
```

Body contains categorized facts about the user (preferences, routines, dates, etc.). Regenerated from the Memory collection on each curation cycle — always reflects the current set of facts after ADD/UPDATE/DELETE operations.

### memories/milestones.md

No required frontmatter. Body contains dated relationship milestones, memorable moments, and inside jokes.

### memories/conversations/{timestamp}.md

```yaml
---
type: "conversation-summary"
chatId: <string>
messageCount: <number>
timestamp: <ISO8601 string>
emotionalTone: <1-10>
importance: <1-10>
followUps: ["<action item>", ...]
---
```

Body contains bullet-point summaries: facts learned, emotional highlights, topics discussed, promises or follow-ups. Each summary is also stored in the MongoDB Memory collection (dual-write) for semantic search and auto-injection into the system prompt.

### memories/conversations/week-of-{date}.md

```yaml
---
type: "weekly-summary"
weekOf: <date string>
---
```

Body contains a compressed summary of multiple daily summaries from that week.

## Vault Operations

Implemented in `src/memory/vault.ts`:

| Function | Description |
|---|---|
| `readVaultFile(path)` | Read file, parse frontmatter + content. Returns `null` on missing file. |
| `writeVaultFile(path, content, frontmatter)` | Write file with frontmatter. Creates parent dirs. |
| `deleteVaultFile(path)` | Delete a vault file. Used by weekly merge to clean up merged daily files. |
| `appendToVaultFile(path, content)` | Append with line-level deduplication (case-insensitive). Preserves headers. |
| `listVaultFiles(dir)` | Recursive walk, returns all `.md` file paths. |
| `searchVault(query)` | Case-insensitive line matching across all files. Top 5 excerpts per file, sorted by match count. |

All vault paths are resolved relative to `VAULT_PATH` and include a path traversal guard — any attempt to resolve a path outside the vault directory is blocked.

The LLM accesses these operations through the `readMemory`, `writeMemory`, and `searchMemory` tools.

## Memory Engine

The Memory Engine (`src/memory/engine.ts`) provides a semantic memory layer backed by MongoDB and Google Gemini embeddings.

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
| `type` | `"fact" \| "episode" \| "milestone"` | Memory category |
| `source` | `string` | Origin: `"curation"`, `"tool"`, `"manual"` |
| `embedding` | `number[]` | 3072-dim vector from gemini-embedding-001 |
| `metadata.chatId` | `string?` | Associated chat |
| `metadata.emotionalTone` | `number?` | 1-10 scale |
| `metadata.importance` | `number?` | 1-10 scale |
| `metadata.followUps` | `string[]?` | Unresolved action items |
| `metadata.createdAt` | `Date` | When the memory was created |
| `metadata.updatedAt` | `Date` | When the memory was last modified |
| `metadata.vaultPath` | `string?` | Links back to vault file if applicable |

Indexed on `type`, `metadata.chatId`, and `metadata.createdAt`.

### Engine API

Implemented in `src/memory/engine.ts`:

| Function | Description |
|---|---|
| `remember(content, type, source, opts?)` | Embed content, store in MongoDB. Returns the created document. |
| `recall(query, opts?)` | Embed query, composite scoring search. Options: `type`, `limit` (default 10), `minScore` (default 0.3, applied as relevance floor). Score = 0.50×relevance + 0.25×recency + 0.15×importance + 0.10×emotional. |
| `forget(memoryId)` | Delete a memory by ID. Vault file left intact as archive. |
| `getRecentEpisodes(limit?)` | Fetch last N episode-type memories by date. Used by context assembly. |
| `getAllFacts()` | Fetch all fact-type memories. Used by curation for classify-then-act. |
| `getActiveFollowUps()` | Collect unresolved follow-up items from recent memories. Used by context assembly. |

## Curation Pipeline

Implemented in `src/memory/curator.ts`. Triggered automatically when a conversation exceeds 40 messages.

```
curateIfNeeded(chatId)
    │
    ├─ 1. Detect overflow (messages > 40)
    │
    ├─ 1.5 Debounce check — skip if < 5 messages since last curation
    │
    ├─ 2. Extract overflow messages (everything before the 40-msg cutoff)
    │
    ├─ 3. Format as transcript (role: content)
    │
    ├─ 4. LLM summarizes → bullet points + structured metadata:
    │      • Facts learned, emotional highlights, topics discussed
    │      • emotionalTone (1-10), importance (1-10), followUps []
    │
    ├─ 5. Dual-write summary:
    │      • vault/memories/conversations/{ISO_TIMESTAMP}.md (with metadata frontmatter)
    │      • Memory collection as "episode" type (with embedding)
    │
    ├─ 6. updateUserFacts(summary) — Mem0-style classify-then-act:
    │      • Load all existing facts from Memory collection
    │      • LLM classifies each fact as ADD / UPDATE / DELETE / NOOP
    │      • Execute operations against Memory collection
    │      • Regenerate about-you.md from all current facts (clean overwrite)
    │
    ├─ 7. Trim conversation to last 40 messages
    │
    └─ 8. checkWeeklyMerge()
           • Find conversation files older than 7 days
           • If 7+ files: weeklyDeepCuration()
              └─ Read all old daily summaries
              └─ LLM compresses into single weekly summary
              └─ Write → week-of-{DATE}.md
              └─ Delete merged daily files to prevent re-merging
```

## System Prompt Assembly

Implemented in `src/ai/context-assembler.ts`. The system prompt is assembled from vault files at generation time.

### Standard prompt (`assembleSystemPrompt`)

Loads and concatenates (separated by `---`):

1. **Personality card** — `vault/personality/card.md` content
2. **User knowledge** — `vault/memories/about-you.md` content
3. **Milestones** — `vault/memories/milestones.md` content
4. **Recent episodes** — last 2-3 conversation summaries from Memory Engine (auto-loaded)
5. **Follow-ups** — unresolved follow-up items from Memory Engine (auto-loaded)
6. **Datetime context** — current time + time-of-day category (late night, morning, afternoon, evening, night)
7. **Tool usage instructions** — when/how to use each tool
8. **Response format instructions** — message length, splitting, style

### Proactive prompt (`assembleProactiveSystemPrompt`)

Same as standard (including recent episodes + follow-ups) but replaces response format with proactive message instructions. The memory context enables proactive messages that reference recent conversations and follow up on unresolved items.

### Message history (`assembleMessages`)

Loads last 40 messages from the conversation. Reconstructs tool-call/tool-result pairs so the model sees its own prior tool usage. User messages with images become multi-part content (image + text).
