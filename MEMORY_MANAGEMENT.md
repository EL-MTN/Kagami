# Mashiro's Memory: Deep Dive & Improvement Roadmap

## Current Architecture

Mashiro's memory operates in four tiers:

| Tier | Storage | Scope | What's in it |
|------|---------|-------|-------------|
| **Hot** | MongoDB `conversations` | Today's 40 messages | Raw messages, images, tool calls |
| **Warm** | MongoDB `memories` collection | All curated memories | Embeddings, structured metadata, facts/episodes/milestones |
| **Cold** | `vault/memories/conversations/*.md` | Daily/weekly summaries | Human-readable summaries with YAML frontmatter |
| **Static** | `vault/memories/about-you.md`, `milestones.md` | Regenerated facts | Clean fact list regenerated from Warm tier each curation cycle |

The personality card (`vault/personality/card.md`) sits outside this hierarchy as a static, hand-edited identity definition.

### Data Flow Between Tiers

```
User sends message
       |
       v
[HOT] MongoDB Conversation
  - appendMessage (user)
  - getOrCreateConversation (daily scoped)
       |
       v (if messages > 40, debounced: 5+ overflow)
[CURATION TRIGGER]
  - getOverflowMessages -> messages[0..N-40]
  - LLM summarizes overflow transcript + extracts structured metadata
  - Dual-write summary:
      -> [COLD] vault/memories/conversations/{timestamp}.md (with frontmatter)
      -> [WARM] Memory collection as "episode" (with embedding)
  - LLM classifies facts as ADD/UPDATE/DELETE/NOOP against existing facts
  - Execute operations against [WARM] Memory collection
  - Regenerate [STATIC] about-you.md from all current facts
  - trimConversation -> MongoDB kept at 40
  - checkWeeklyMerge -> if 7+ old files:
      - weeklyDeepCuration -> [COLD] conversations/week-of-{date}.md
      - delete merged [COLD] files
       |
       v
[ASSEMBLY] assembleSystemPrompt()
  - [STATIC] personality/card.md    --+
  - [STATIC] about-you.md            |
  - [STATIC] milestones.md           +-- Always in system prompt
  - [WARM] recent episodes (last 3)  |
  - [WARM] active follow-ups        --+
       |
       v
generateText() with tools
  - LLM may search [WARM] via searchMemory (hybrid semantic + keyword)
  - LLM may browse [WARM] via listMemories
  - LLM may read [COLD] via readMemory
  - LLM may write [COLD + WARM] via writeMemory (dual-write)
```

### What the LLM Sees at Generation Time

**Always (system prompt):**
- Full character definition (personality/card.md)
- All known facts about the user (about-you.md, regenerated from Memory collection)
- Relationship milestones (milestones.md)
- Last 2-3 conversation summaries from Memory Engine (auto-injected)
- Active follow-up items from Memory Engine (auto-injected)
- Current date/time with time-of-day label
- Tool usage instructions
- Response format instructions

**Always (message history):**
- Up to 40 messages from today's conversation, including reconstructed tool calls

**On-demand (via tools, within 5 maxSteps):**
- Semantic + keyword hybrid search results (searchMemory)
- Memory discovery by type/date (listMemories)
- Specific vault file by path (readMemory)
- Write to vault + Memory collection (writeMemory)

### Memory Write Paths

**1. Automatic Curation (overflow-triggered, debounced)**
- Fires when today's conversation exceeds 40 messages (skipped if < 5 messages since last curation)
- Formats overflow as `role: content` transcript
- LLM summarizes into bullet points + structured metadata (emotionalTone, importance, followUps)
- Dual-writes: vault file with frontmatter + Memory collection episode with embedding
- LLM classifies facts as ADD/UPDATE/DELETE against existing Memory collection facts
- Regenerates `about-you.md` from all current facts (clean overwrite)
- Trims MongoDB conversation to 40 messages

**2. LLM-triggered writeMemory tool (dual-write)**
- Mashiro can write to any vault path via `writeMemory`
- Append mode: line-level deduplication (case-insensitive exact match)
- Overwrite mode: replaces entire file
- Writes to `about-you.md` or `milestones.md` also store in Memory collection for semantic search
- Returns current file state after write for verification

**3. Weekly deep curation (merge)**
- Triggers when 7+ daily summary files are older than 7 days
- LLM compresses all old dailies into single weekly summary
- Merged daily files are deleted

### Memory Read Paths

**1. System prompt assembly (automatic, every generation)**
- Reads personality/card.md, about-you.md, milestones.md from vault
- Loads last 2-3 episodes from Memory Engine (recent conversation summaries)
- Loads active follow-ups from Memory Engine

**2. Message history assembly (automatic, every generation)**
- Queries MongoDB for today's conversation only
- Returns last 40 messages with reconstructed tool-call pairs

**3. searchMemory tool (LLM-initiated, hybrid)**
- Runs semantic search (cosine similarity on embeddings) and keyword search (vault substring) in parallel
- Merges and deduplicates results, returns top 10 ranked by relevance

**4. listMemories tool (LLM-initiated)**
- Queries Memory collection by type (fact/episode/milestone)
- Returns date, preview, importance, and follow-up status

**5. readMemory tool (LLM-initiated)**
- Reads a specific vault file by path
- Returns content only (frontmatter discarded from return value)

---

## Remaining Memory Gaps

### Open Gaps

**5. Curation discards image content and tool call details.**
The transcript is `${m.role}: ${m.content}`. Photos become `"user: [photo]"`. Tool call metadata (what Mashiro searched, what she wrote, what photos she generated) is stripped. Visual and tool-usage context is permanently lost.

**6. Line-level dedup in vault is semantically blind.**
`appendToVaultFile` deduplicates via exact string matching (case-insensitive). "Likes pizza" blocks "likes pizza" but not "enjoys pizza" or "pizza fan". This is mitigated by the fact management system (ADD/UPDATE/DELETE operates at the semantic level via LLM classification), but the vault append function itself remains substring-only.

**8. No emotional trajectory tracking.**
Structured emotional metadata (emotionalTone 1-10) is now stored per episode, but there's no rolling sentiment baseline or trend analysis. The data exists for future use.

**9. No temporal awareness of memory age.**
Facts have `createdAt`/`updatedAt` timestamps in the Memory collection, but retrieval doesn't weight by recency. Old facts are ranked equally to new ones in similarity search.

**10. Weekly merge threshold is fragile.**
Requires exactly 7+ files older than 7 days. If curation runs infrequently (6 files never merge). Weekly merge only fires from `curateIfNeeded`, which only runs on user messages — never on proactive paths.

### Resolved Gaps

| Gap | Resolution |
|-----|-----------|
| 1. Summaries never auto-loaded | `assembleMemoryContext()` injects last 2-3 episodes into system prompt |
| 2. Hard amnesia at midnight | Recent episodes bridge the day boundary automatically |
| 3. No discovery mechanism | `listMemories` tool lets Mashiro browse memories by type/date |
| 4. Search is substring-only | Hybrid semantic + keyword search via Memory Engine |
| 7. Facts only append | Mem0-style ADD/UPDATE/DELETE classification, clean regeneration |
| 11. Per-message curation waste | Debounced at 5+ messages since last curation |
| 12. Proactive messages blind | Follow-ups + recent episodes injected into proactive prompt |

---

## Future Improvements

### Priority 5: Cross-day context bridge

**Impact:** Medium | **Effort:** Low

Largely addressed by auto-loading recent episodes. A targeted improvement would be injecting the *tail end* of yesterday's last summary specifically — capturing how the last session ended, final mood, unresolved threads.

### Priority 6: Memory-aware proactive messaging (deep)

**Impact:** Medium | **Effort:** Medium

The basic version is done (follow-ups + episodes in proactive prompt). The deeper version would query for upcoming dates/events, time-of-day behavioral patterns, and do targeted memory retrieval before generating proactive messages.

### Priority 8: Monthly consolidation tier

**Impact:** Lower | **Effort:** Low

Add a monthly pass that reads all weekly summaries and extracts evolving patterns: "relationship dynamic shifted from X to Y," "recurring topics," "emotional baseline." This becomes the seed for procedural memory.

### Priority 9: Entity extraction and tracking

**Impact:** Lower | **Effort:** Higher

During curation, extract named entities (people, places, events) into structured MongoDB documents. Track relationships ("Mom" -> user's mother), first mention dates, and event statuses (upcoming/past).

### Priority 10: Memory importance scoring for retrieval

**Impact:** Lower | **Effort:** Medium

Implement the Generative Agents scoring formula:

```
score = 0.50 * semantic_relevance
      + 0.25 * recency (exponential decay, 30-day half-life)
      + 0.15 * importance (LLM-assigned 1-10)
      + 0.10 * emotional_weight
```

The metadata (importance, emotionalTone, createdAt) is already stored — this is purely a retrieval scoring change in `engine.ts`.

---

## Architecture Vision

```
+----------------------- Always In Prompt ------------------------+
|  Personality card          (file, static)                       |
|  Top user facts            (from DB, regenerated)         [done]|
|  Milestones                (file, LLM-maintained)               |
|  Recent episode context    (last 2-3 summaries, auto)     [done]|
|  Emotional baseline        (rolling sentiment average)          |
|  Active follow-ups         (from curation metadata)       [done]|
|  Datetime + time-of-day                                         |
+-----------------------------------------------------------------+
                              +
+---------------------- On-Demand via Tools ----------------------+
|  Semantic search     (vector similarity + keyword hybrid) [done]|
|  Memory browsing     (list by type/date)                  [done]|
|  Temporal search     (date-filtered retrieval)                  |
|  Entity lookup       (structured people/places/events)          |
|  Episode deep-read   (full summary file by path)          [done]|
+-----------------------------------------------------------------+
                              +
+---------------------- Background Pipeline ----------------------+
|  Curation (40-msg overflow -> summarize -> extract facts) [done]|
|  Fact management (ADD/UPDATE/DELETE, not just append)      [done]|
|  Curation debounce (5+ messages threshold)                [done]|
|  Weekly consolidation (daily -> weekly rollups)            [done]|
|  Monthly consolidation (weekly -> relationship patterns)        |
|  Importance decay (score adjustment over time)                  |
+-----------------------------------------------------------------+
```

---

## Research References

- **MemGPT / Letta** — Hierarchical memory with context paging. The LLM manages its own memory via tools, treating the context window as RAM and external storage as disk.
- **Mem0** — ADD/UPDATE/DELETE memory management pattern. 26% accuracy improvement over append-only approaches, 90% token reduction.
- **Generative Agents (Park et al.)** — Memory importance scoring formula: recency + importance + relevance. LLM-assigned importance scores on 1-10 scale.
- **Zep / Graphiti** — Bi-temporal knowledge graph with event time vs ingestion time tracking. 94.8% accuracy on memory benchmarks.
- **Cognitive Architecture (CoALA)** — Episodic/semantic/procedural memory taxonomy from cognitive science, applied to LLM agents.
