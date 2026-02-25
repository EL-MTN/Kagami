# Mashiro's Memory: Deep Dive & Improvement Roadmap

## Current Architecture

Mashiro's memory operates in four tiers:

| Tier | Storage | Scope | What's in it |
|------|---------|-------|-------------|
| **Hot** | MongoDB `conversations` | Today's 40 messages | Raw messages, images, tool calls |
| **Warm** | MongoDB `memories` collection | All curated memories | Embeddings, structured metadata, facts/episodes/milestones |
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
       v (if overflow >= 40 messages beyond context window)
[CURATION TRIGGER]
  - getOverflowMessages -> messages[0..N-40]
  - LLM summarizes overflow transcript + extracts structured metadata
  - Store as [WARM] Memory collection episode (with embedding) — single source of truth
  - LLM classifies facts as ADD/UPDATE/DELETE/NOOP against existing facts
  - Execute operations against [WARM] Memory collection
  - Regenerate [STATIC] about-you.md from all current facts
  - trimConversation -> MongoDB kept at 40
  - checkWeeklyMerge -> if 4+ old curation episodes (>7 days):
      - weeklyDeepCuration -> [WARM] episode with source "weekly-merge"
      - delete merged daily episodes
  - checkMonthlyConsolidation -> if 3+ old weekly-merge episodes (>30 days):
      - monthlyDeepConsolidation -> [WARM] milestone
      - delete merged weekly episodes
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
- Emotional trend note (when mood is rising or falling, not when stable)
- Current date/time with time-of-day label
- Tool usage instructions
- Response format instructions

**Always (message history):**
- Up to 40 messages from today's conversation, including reconstructed tool calls

**On-demand (via tools, within 5 maxSteps):**
- Semantic + keyword hybrid search results (searchMemory)
- Memory discovery by type/date (listMemories)
- Specific vault file by path (readMemory) — personality, about-you, milestones
- Write to vault + Memory collection (writeMemory)

### Memory Write Paths

**1. Automatic Curation (batch-triggered)**
- Fires when 40+ messages overflow beyond the 40-message context window (i.e., at 80 total messages)
- Formats overflow as rich transcript (images as `[sent a photo]`, tool calls as human-readable descriptions)
- LLM summarizes into bullet points + structured metadata (emotionalTone, importance, followUps)
- Stores episode in Memory collection with embedding (MongoDB only — no vault file)
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
- Triggers when 4+ curation episodes are older than 7 days
- Also fires from proactive scheduler (not just curation)
- LLM compresses all old dailies into single weekly summary
- Stored as episode with source `"weekly-merge"` in Memory collection
- Merged daily episodes are deleted from MongoDB

**4. Monthly consolidation**
- Triggers when 3+ weekly-merge episodes are older than 30 days
- Also fires from proactive scheduler
- LLM extracts relationship patterns and long-term observations
- Stored as milestone in Memory collection (full text, no truncation)
- Merged weekly episodes are deleted from MongoDB

### Memory Read Paths

**1. System prompt assembly (automatic, every generation)**
- Reads personality/card.md, about-you.md, milestones.md from vault
- Loads last 2-3 episodes from Memory Engine (recent conversation summaries)
- Loads active follow-ups from Memory Engine

**2. Message history assembly (automatic, every generation)**
- Queries MongoDB for today's conversation only
- Returns last 40 messages with reconstructed tool-call pairs

**3. searchMemory tool (LLM-initiated, hybrid)**
- Runs semantic search (composite scoring on embeddings) and keyword search (vault substring) in parallel
- Composite score: 0.50×relevance + 0.25×recency + 0.15×importance + 0.10×emotional
- Merges and deduplicates results, returns top 10 ranked by composite score

**4. listMemories tool (LLM-initiated)**
- Queries Memory collection by type (fact/episode/milestone)
- Returns date, preview, importance, and follow-up status

**5. readMemory tool (LLM-initiated)**
- Reads a specific vault file by path
- Returns content only (frontmatter discarded from return value)

---

## Remaining Memory Gaps

### Open Gaps

**6. Line-level dedup in vault is semantically blind.**
`appendToVaultFile` deduplicates via exact string matching (case-insensitive). "Likes pizza" blocks "likes pizza" but not "enjoys pizza" or "pizza fan". This is mitigated by the fact management system (ADD/UPDATE/DELETE operates at the semantic level via LLM classification), but the vault append function itself remains substring-only.

### Resolved Gaps

| Gap | Resolution |
|-----|-----------|
| 1. Summaries never auto-loaded | `assembleMemoryContext()` injects last 2-3 episodes into system prompt |
| 2. Hard amnesia at midnight | Recent episodes bridge the day boundary automatically |
| 3. No discovery mechanism | `listMemories` tool lets Mashiro browse memories by type/date |
| 4. Search is substring-only | Hybrid semantic + keyword search via Memory Engine |
| 5. Curation discards images/tools | Rich transcript formatting: images as `[sent a photo]`, tool calls as human-readable descriptions |
| 7. Facts only append | Mem0-style ADD/UPDATE/DELETE classification, clean regeneration |
| 8. No emotional trajectory | `getEmotionalBaseline()` with trend injection into system prompt when mood is rising/falling |
| 9. No temporal awareness | Composite retrieval scoring: 0.50×relevance + 0.25×recency + 0.15×importance + 0.10×emotional |
| 10. Weekly merge threshold fragile | Lowered to 4+ files, fires from both curation and proactive scheduler |
| 11. Per-message curation waste | Batch curation: 40-message minimum before summarizing |
| 12. Proactive messages blind | Follow-ups + recent episodes injected into proactive prompt |

---

## Future Improvements

### Priority 5: Cross-day context bridge

**Impact:** Medium | **Effort:** Low

Largely addressed by auto-loading recent episodes. A targeted improvement would be injecting the *tail end* of yesterday's last summary specifically — capturing how the last session ended, final mood, unresolved threads.

### Priority 6: Memory-aware proactive messaging (deep)

**Impact:** Medium | **Effort:** Medium

The basic version is done (follow-ups + episodes in proactive prompt). The deeper version would query for upcoming dates/events, time-of-day behavioral patterns, and do targeted memory retrieval before generating proactive messages.

### Priority 8: Entity extraction and tracking

**Impact:** Lower | **Effort:** Higher

During curation, extract named entities (people, places, events) into structured MongoDB documents. Track relationships ("Mom" -> user's mother), first mention dates, and event statuses (upcoming/past).

---

## Architecture Vision

```
+----------------------- Always In Prompt ------------------------+
|  Personality card          (file, static)                       |
|  Top user facts            (from DB, regenerated)         [done]|
|  Milestones                (file, LLM-maintained)               |
|  Recent episode context    (last 2-3 summaries, auto)     [done]|
|  Emotional baseline        (trend when rising/falling)    [done]|
|  Active follow-ups         (from curation metadata)       [done]|
|  Datetime + time-of-day                                         |
+-----------------------------------------------------------------+
                              +
+---------------------- On-Demand via Tools ----------------------+
|  Composite search    (relevance+recency+importance+emo)   [done]|
|  Memory browsing     (list by type/date)                  [done]|
|  Temporal search     (date-filtered retrieval)                  |
|  Entity lookup       (structured people/places/events)          |
|  Episode deep-read   (full summary file by path)          [done]|
+-----------------------------------------------------------------+
                              +
+---------------------- Background Pipeline ----------------------+
|  Curation (40-msg overflow -> summarize -> extract facts) [done]|
|  Rich transcripts (images, tool calls, role names)        [done]|
|  Fact management (ADD/UPDATE/DELETE, not just append)      [done]|
|  Batch curation (40-message minimum overflow)             [done]|
|  Weekly consolidation (daily -> weekly, threshold 4+)     [done]|
|  Monthly consolidation (weekly -> relationship patterns)  [done]|
|  Proactive consolidation (merge checks on timer fire)     [done]|
+-----------------------------------------------------------------+
```

---

## Research References

- **MemGPT / Letta** — Hierarchical memory with context paging. The LLM manages its own memory via tools, treating the context window as RAM and external storage as disk.
- **Mem0** — ADD/UPDATE/DELETE memory management pattern. 26% accuracy improvement over append-only approaches, 90% token reduction.
- **Generative Agents (Park et al.)** — Memory importance scoring formula: recency + importance + relevance. LLM-assigned importance scores on 1-10 scale.
- **Zep / Graphiti** — Bi-temporal knowledge graph with event time vs ingestion time tracking. 94.8% accuracy on memory benchmarks.
- **Cognitive Architecture (CoALA)** — Episodic/semantic/procedural memory taxonomy from cognitive science, applied to LLM agents.
