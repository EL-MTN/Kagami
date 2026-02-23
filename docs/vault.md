# Vault & Memory System

The vault is a file-based memory store using Markdown files with YAML frontmatter. It holds the AI's personality definition, learned user facts, relationship milestones, and conversation summaries. Files are human-readable and editable.

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
updated: <ISO8601 timestamp>
---
```

Body contains categorized facts about the user (preferences, routines, dates, etc.). Auto-updated by the curation pipeline when new facts are learned.

### memories/milestones.md

No required frontmatter. Body contains dated relationship milestones, memorable moments, and inside jokes.

### memories/conversations/{timestamp}.md

```yaml
---
type: "conversation-summary"
chatId: <string>
messageCount: <number>
timestamp: <ISO8601 string>
---
```

Body contains bullet-point summaries: facts learned, emotional highlights, topics discussed, promises or follow-ups, and curator notes.

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
| `appendToVaultFile(path, content)` | Append with line-level deduplication (case-insensitive). Preserves headers. |
| `listVaultFiles(dir)` | Recursive walk, returns all `.md` file paths. |
| `searchVault(query)` | Case-insensitive line matching across all files. Top 5 excerpts per file, sorted by match count. |

The LLM accesses these operations through the `readMemory`, `writeMemory`, and `searchMemory` tools.

## Curation Pipeline

Implemented in `src/memory/curator.ts`. Triggered automatically when a conversation exceeds 40 messages.

```
curateIfNeeded(chatId)
    │
    ├─ 1. Detect overflow (messages > 40)
    │
    ├─ 2. Extract overflow messages (everything before the 40-msg cutoff)
    │
    ├─ 3. Format as transcript (role: content)
    │
    ├─ 4. LLM summarizes → bullet points:
    │      • Facts learned
    │      • Emotional highlights
    │      • Topics discussed
    │      • Promises / follow-ups
    │      • Curator's note
    │
    ├─ 5. Write summary → vault/memories/conversations/{ISO_TIMESTAMP}.md
    │
    ├─ 6. updateUserFacts(summary)
    │      • Read current about-you.md
    │      • LLM extracts NEW facts not already present
    │      • Append new facts with date header (or "NONE")
    │
    ├─ 7. Trim conversation to last 40 messages
    │
    └─ 8. checkWeeklyMerge()
           • Find conversation files older than 7 days
           • If 7+ files: weeklyDeepCuration()
              └─ Read all old daily summaries
              └─ LLM compresses into single weekly summary
              └─ Write → week-of-{DATE}.md
```

## System Prompt Assembly

Implemented in `src/ai/context-assembler.ts`. The system prompt is assembled from vault files at generation time.

### Standard prompt (`assembleSystemPrompt`)

Loads and concatenates (separated by `---`):

1. **Personality card** — `vault/personality/card.md` content
2. **User knowledge** — `vault/memories/about-you.md` content
3. **Milestones** — `vault/memories/milestones.md` content
4. **Datetime context** — current time + time-of-day category (late night, morning, afternoon, evening, night)
5. **Tool usage instructions** — when/how to use each tool
6. **Response format instructions** — message length, splitting, style

### Proactive prompt (`assembleProactiveSystemPrompt`)

Same as standard but replaces response format with proactive message instructions (initiate naturally, single short message, text about what's on your mind).

### Message history (`assembleMessages`)

Loads last 40 messages from the conversation. Reconstructs tool-call/tool-result pairs so the model sees its own prior tool usage. User messages with images become multi-part content (image + text).
