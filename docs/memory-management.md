# Mashiro's Memory: Architecture & Design

## Architecture

Mashiro's memory operates in five tiers:

| Tier        | Storage                                | Scope                   | What's in it                                               |
| ----------- | -------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| **Hot**     | MongoDB `conversations`                | Active session messages | Raw messages, images, tool calls                           |
| **Working** | MongoDB `memories` (type: `"working"`) | Session-scoped, 24h TTL | Temporary notes (auto-deleted by MongoDB TTL index)        |
| **Warm**    | MongoDB `memories` collection          | All curated memories    | Embeddings, structured metadata, facts/episodes/milestones |
| **Archive** | MongoDB `memories` (with `archivedAt`) | Soft-archived originals | Preserved after merge; excluded from search/context        |
| **Static**  | `vault/personality/card.md`            | Hand-edited             | Character definition only                                  |

The personality card (`vault/personality/card.md`) is the only vault file — all facts, milestones, and episodes live exclusively in MongoDB.

### Data Flow Between Tiers

```
User sends message
       |
       v
[HOT] MongoDB Conversation (session-based)
  - getOrCreateSession (idle-based: 1h threshold)
  - If stale session detected → close old, curate in background, create new
  - appendMessage (user)
       |
       v (if overflow >= 40 messages beyond context window)
[CURATION TRIGGER] (fire-and-forget, non-blocking)
  - getOverflowMessages -> messages[0..N-40]
  - LLM summarizes overflow transcript + extracts structured metadata
  - Store as [WARM] Memory collection episode (with embedding)
  - LLM classifies facts as ADD/UPDATE/DELETE against 30 most relevant facts
  - Execute operations against [WARM] Memory collection
  - trimConversation -> MongoDB kept at 40
       |
       v (on proactive scheduler only)
[MERGE] Weekly + Monthly consolidation
  - Weekly: 4+ old daily episodes → merged weekly summary
  - Monthly: 3+ old weekly episodes → relationship insights milestone
  - Originals soft-archived (metadata.archivedAt), not deleted
       |
       v
[ASSEMBLY] assembleSystemPrompt(chatId, sessionId?)
  - [STATIC] personality/card.md         --+
  - [WARM] top 30 facts (by importance)    |
  - [WARM] recent milestones (last 5)      |
  - [WARM] daily episodes (last 3)         +-- Always in system prompt
  - [WARM] weekly episodes (last 2)        |
  - [WORKING] session notes (if any)       |
  - [WARM] active follow-ups (30d, dedup) --+
       |
       v
generateText() with tools
  - LLM may search [WARM] via searchMemory (semantic, type-filterable)
  - LLM may browse [WARM] via listMemories (excludes archived)
  - LLM may read [STATIC] via readMemory (personality card)
  - LLM may read [WARM] via readMemory (by memory ID)
  - LLM may store [WARM] via rememberFact (direct-to-MongoDB)
  - LLM may store [WORKING] via noteToSelf (session-scoped, 24h TTL)
```

### What the LLM Sees at Generation Time

**Always (system prompt):**

- Full character definition (personality/card.md)
- Top 30 facts about the user (from MongoDB, sorted by importance)
- Recent milestones (last 5, from MongoDB)
- Last 3 daily conversation summaries (from MongoDB, excludes weekly/monthly merges)
- Last 2 weekly summaries (from MongoDB)
- Working memory notes for this session (if any)
- Active follow-up items (30-day age limit, deduplicated)
- Emotional trend note (when mood is rising or falling, not when stable)
- Active reminders: pending + recently fired in last 12h (proactive prompts only)
- Current date/time with time-of-day label
- Tool usage instructions
- Response format instructions

**Always (message history):**

- Up to 40 messages from the active session, including reconstructed tool calls

**On-demand (via tools, within 5 steps):**

- Semantic search results with optional type filter (searchMemory)
- Memory discovery by type/date, excluding archived (listMemories)
- Specific vault file or memory by ID (readMemory)
- Direct fact/milestone storage (rememberFact)
- Session-scoped temporary notes (noteToSelf)

### Session Lifecycle

Conversations use idle-based sessions instead of daily scoping:

1. **getOrCreateSession(chatId)** — finds the most recent `status: "active"` conversation
2. If found and idle < 1 hour → return it (same session continues)
3. If found and idle >= 1 hour → close it, queue background curation, create new session
4. If not found → create new session

This eliminates "cross-midnight amnesia" — sessions naturally span day boundaries. A session only closes after 1 hour of inactivity.

### Memory Write Paths

**1. Automatic Curation (batch-triggered, non-blocking)**

- Fires as fire-and-forget when 40+ messages overflow beyond the 40-message context window
- Per-chat mutex prevents concurrent curation runs
- Formats overflow as rich transcript (images as `[sent a photo]`, tool calls as human-readable descriptions)
- LLM summarizes via `generateObject()` → structured output (summary, emotionalTone, importance, followUps)
- Stores episode in Memory collection with embedding
- LLM classifies facts via bounded retrieval: 30 most relevant facts (not all facts)
- Trims MongoDB conversation to 40 messages

**2. Session-end curation (background)**

- Triggered when `getOrCreateSession` detects and closes a stale session
- Short sessions (< 5 messages) → lightweight summary with importance 3
- Longer sessions → full summarization + fact extraction

**3. LLM-triggered rememberFact tool (direct-to-MongoDB)**

- Stores facts or milestones directly in the Memory collection
- Parameters: content, type (fact/milestone), importance (1-10)
- No vault involvement

**4. LLM-triggered noteToSelf tool (working memory)**

- Stores session-scoped temporary notes
- Auto-expires after 24 hours (MongoDB TTL index)

**5. Weekly deep curation (non-destructive merge)**

- Triggers when 4+ curation episodes are older than 7 days
- Fires from proactive scheduler only (decoupled from curation)
- LLM compresses all old dailies into single weekly summary
- Stored as episode with source `"weekly-merge"`
- Original daily episodes soft-archived (`metadata.archivedAt` set)

**6. Monthly consolidation (non-destructive merge)**

- Triggers when 3+ weekly-merge episodes are older than 30 days
- Fires from proactive scheduler only
- LLM extracts relationship patterns and long-term observations
- Stored as milestone in Memory collection
- Original weekly episodes soft-archived

### Memory Read Paths

**1. System prompt assembly (automatic, every generation)**

- Loads top 30 facts from MongoDB (sorted by importance desc)
- Loads last 5 milestones from MongoDB
- Loads separated episode types: 3 daily + 2 weekly
- Loads working memory for current session
- Loads active follow-ups (30-day age limit, deduplicated)
- Reads personality/card.md from vault

**2. Message history assembly (automatic, every generation)**

- Queries active session's conversation
- Returns last 40 messages with reconstructed tool-call pairs

**3. searchMemory tool (LLM-initiated, semantic)**

- All search goes through Memory Engine's `recall()` function
- Tiered search: 90 days first, widens to 365 if insufficient results
- Composite score: 0.50×relevance + 0.25×recency + 0.15×importance + 0.10×emotional
- Hard cap: 200 candidates loaded per search (sorted by recency)
- Excludes archived memories and working memory
- Optional type filter parameter

**4. listMemories tool (LLM-initiated)**

- Queries Memory collection by type (fact/episode/milestone)
- Excludes archived memories by default
- Returns date, preview, importance, and follow-up status

**5. readMemory tool (LLM-initiated)**

- Reads a specific vault file by path (personality card)
- OR reads a specific memory by ID from MongoDB

### Archival Model

Merges use soft-archival instead of hard deletion:

- `metadata.archivedAt` — timestamp when archived
- `metadata.mergedInto` — ObjectId of the merge target
- Archived memories excluded from all searches and context assembly
- Can be retrieved for deep investigation if needed

### Follow-up Lifecycle

- Follow-ups extracted during curation and stored in memory metadata
- Age filter: only follow-ups from the last 30 days appear in the system prompt
- Deduplication: lowercased text matching prevents repeated items
- Resolution: `resolveFollowUp(memoryId, text)` removes a specific follow-up

### Cleanup

- **Working memory**: MongoDB TTL index auto-deletes expired entries
- **Fired reminders**: Cleaned up daily (older than 30 days)
- **Closed conversations**: Cleaned up daily (older than 90 days)
- **Workflow logs**: Cleaned up daily (older than 90 days)

---

## Indexes

```
Memory collection:
  { type: 1 }                                           — type filtering
  { "metadata.chatId": 1 }                              — chat-scoped queries
  { "metadata.createdAt": -1 }                          — recency sorting
  { type: 1, "metadata.archivedAt": 1 }                 — active vs archived
  { type: 1, source: 1, "metadata.createdAt": -1 }      — separated episode types
  { "metadata.expiresAt": 1 } (TTL, expireAfterSeconds: 0) — working memory auto-cleanup

Conversation collection:
  { chatId: 1, updatedAt: -1 }                          — recent conversation lookup
  { chatId: 1, status: 1, updatedAt: -1 }               — session lifecycle
```

---

## Research References

- **MemGPT / Letta** — Hierarchical memory with context paging. The LLM manages its own memory via tools, treating the context window as RAM and external storage as disk.
- **Mem0** — ADD/UPDATE/DELETE memory management pattern. 26% accuracy improvement over append-only approaches, 90% token reduction.
- **Generative Agents (Park et al.)** — Memory importance scoring formula: recency + importance + relevance. LLM-assigned importance scores on 1-10 scale.
- **Zep / Graphiti** — Bi-temporal knowledge graph with event time vs ingestion time tracking. 94.8% accuracy on memory benchmarks.
- **Cognitive Architecture (CoALA)** — Episodic/semantic/procedural memory taxonomy from cognitive science, applied to LLM agents.
