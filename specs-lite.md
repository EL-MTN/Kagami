# Brainiac Memory — Lite Spec (v0)

The minimum end-to-end loop. Build this first. Run for 60 days. Port machinery from `specs.md` only when something breaks.

## What this validates
- Conversations → entities works as an extraction shape.
- The LLM can navigate a markdown graph at query time.
- Markdown + wikilinks + git is enough storage.
- The user can edit memory in Obsidian without breaking the system.

## What's deferred to v1
Compaction · Summary regeneration · Anchor obsolescence · Confidence scoring · `status` (dormant/archived) · Invalidation · ER LLM fallback · `_unresolved/` · `compact-journal` · `vault_gc` · `vault_status` · FTS5 · Multi-tier cache · Cloud sub-agent · Schema migrations · Per-entity locks · Bi-temporal observations · `Evolution` rendering · Salience filter · Episodic rollups · Category indices.

## Storage

```
~/memory/
├── _core.md                # always-in-context (manual edits only in lite)
├── index.md                # auto-rebuilt list of all entities
├── raw/<YYYY-MM-DD-HHMM>.md
├── entities/<slug>.md      # one folder; type goes in frontmatter
├── .git/
└── .memory/
    ├── log.jsonl           # append-only observation stream (forensic only)
    ├── llm-failures/<ts>.json
    └── prompts/            # extraction.md, retrieval.md
```

No type subfolders, no `_unresolved/`, no `_archive/`, no `episodic/`, no `indices/`, no derived JSON indexes.

## Conventions

- Filenames are ASCII slugs; `id` field equals the filename stem.
- Wikilinks: `[[alex-smith]]` for entities, `[[raw/2026-04-27-1430]]` for transcripts.
- ISO-8601 dates.
- Sync via git only.

## Transcript format

`raw/<YYYY-MM-DD-HHMM>.md`:

```markdown
---
id: 2026-04-27-1430
started_at: 2026-04-27T14:30:00Z
---

## t-0001 user
<turn text>

## t-0002 assistant
<turn text>
```

## Entity page

```yaml
---
id: alex-smith
name: Alex Smith
aliases: [Alex, A.S.]
type: person
anchor: ""               # optional; user-set
updated: 2026-04-27
---

## About
<optional, free-form, hand-written>

## Observations

### 2026-04-27 — Pushed back on local-first
> "He thinks the sync story is always going to be the bottleneck"
**source:** [[raw/2026-04-27-1430#t-0042]]
**date:** 2026-04-27
```

That's the entire schema. No `confidence`, `status`, `source_count`, `invalidated_by`, `event_time`, `ingested_at`, `summary_regenerated_at`, `anchor_status`, `query_count`, `source_turn`, `relations`, `tags`. None of it.

Types: free-form string. `person`, `belief`, `project`, `place`, `concept`, `preference` are conventional but unenforced.

## Ingestion (1 LLM call)

`consolidate(<transcript-path>)`:

1. Read transcript.
2. **Extract** (LLM, JSON-schema constrained):
   ```json
   [{"entity_name":"Alex","type":"person","aliases_seen":["Alex"],
     "headline":"Pushed back on local-first",
     "quote":"He thinks the sync story...","turn_id":"t-0042","date":"2026-04-27"}]
   ```
   The prompt asks for "memorable facts about the user, their relationships, beliefs, decisions, preferences, and people/places/projects in their life." No salience filter as a separate stage — the extractor's prompt is the filter.

3. For each candidate (deterministic, no LLM):
   - Look up `entity_name` in existing entities by exact case-insensitive match against `name` or `aliases`.
   - **If found** (single match): append observation to that entity's `## Observations` (top, reverse-chronological); union `aliases_seen` into the entity's `aliases`; bump `updated`.
   - **If found** (multiple matches): append to each — duplicates are accepted; you'll fix them later via `merge`. (Yes, this is intentional. It surfaces the ambiguity rather than hiding it.)
   - **If not found**: create new entity file with the candidate's name, type, alias list.
   - Append the observation to `.memory/log.jsonl`.

4. Rebuild `index.md` by scanning `entities/`. One line per entity:
   `- [[<slug>]] — <type> — <name> — aliases: <list>`

On JSON parse failure: retry once. On second failure: write to `.memory/llm-failures/<ts>.json` and skip.

`consolidate` returns `{candidates: int, appended: int, created: int}`.

## Retrieval (1 LLM call)

`query(<question>)`:

1. Load `_core.md` + `index.md`.
2. Run `ripgrep` over `entities/**/*.md` for query terms; gather up to 10 file paths with line context.
3. Single LLM call with: question + `_core.md` + `index.md` + ripgrep hits.
4. The LLM either:
   - Answers directly with citations, OR
   - Issues `view(path)` tool calls (up to 5) to read specific entity files, then answers.

Returns `{answer, citations: [path]}`. No tiers, no router, no cache strategy, no escalation.

## `_core.md` (lite)

Free-form markdown. **Hand-edited only.** Suggested sections: identity, active projects, communication preferences. The lite version doesn't auto-generate `_core.md`; you maintain it. The retrieval LLM always sees it.

## MCP tool surface (6 tools)

| Tool          | Inputs / Behavior                                                                          |
|---------------|---------------------------------------------------------------------------------------------|
| `view`        | `(path, lines?)` — read file or list directory.                                            |
| `query`       | `(question)` — run retrieval. Returns `{answer, citations}`.                               |
| `consolidate` | `(transcript_path)` — run ingestion. Returns `{candidates, appended, created}`.            |
| `create`      | `(path, content)` — create a file (errors if exists).                                      |
| `str_replace` | `(path, old, new)` — replace exact substring. For hand-edits to `_core.md` and entities.   |
| `merge`       | `(from_id, to_id)` — append `from`'s observations to `to`'s, union aliases, delete `from`'s file, rewrite wikilinks vault-wide. Manual de-dup. |

System prompt: read `_core.md` first; cite file paths.

## Operational

- **Sync via git.** Conflict resolution by hand. No locks (single user, single machine in MVP).
- **`.memory/log.jsonl`** is append-only and never read by retrieval. Useful for forensic re-extraction if you change the prompt and want to redo ingestion against history.
- **No daemon for indexes.** `index.md` is rebuilt at the end of every `consolidate`.

## When to graduate to v1

Don't preemptively port from `specs.md`. Port when:

| Pain                                                       | Port                                          |
|------------------------------------------------------------|-----------------------------------------------|
| Entity pages exceed ~3000 words; reading them is slow      | Compaction + Summary regeneration             |
| Manual `merge` calls > weekly                              | ER LLM fallback + `_unresolved/`              |
| You notice the assistant citing stale facts                | Invalidation + `summary_stale` signal         |
| Recall queries cost too many tokens                        | Tier 1 alias index, Tier 2 FTS, cached prefix |
| You edit an entity by hand, ingestion clobbers it          | Per-entity locks                              |
| You can't tell why the agent believes something            | `er-log` + `summary-history`                  |
| You change models and want before/after comparability      | `model_version` + `prompt_version` on observations |
| Beliefs flip and the system doesn't capture the pattern    | Anchor obsolescence + `Evolution` rendering   |

Until those signals fire, **don't build them.**

## Open questions for lite

1. **Implementation language** — Python (rich markdown/YAML/SQLite ecosystem) or TypeScript (MCP SDK ergonomics). Pick before first PR.
2. **Extraction model** — local (LM Studio + 7B) or cloud (Haiku) for v0? Cloud is faster to set up; local is the long-term bet. Lean cloud for MVP, swap to local once the prompt is stable.
3. **Daily-note generation** — auto end-of-day rollup, or skip entirely in lite? Probably skip; raw transcripts are enough.
4. **Encryption-at-rest** — git-crypt or similar before any data lands. Worth doing day 1 since this is therapy-and-relationships data.

## First PR scope

Build:
1. `models.{py,ts}` — Pydantic/Zod for `Candidate`, `EntityFrontmatter`, `Observation`.
2. `transcript.{py,ts}` — turn-segmented reader.
3. `llm.{py,ts}` — thin wrapper over the chosen model with JSON-schema-mode + retry-once.
4. `entity_io.{py,ts}` — read/write entity markdown with frontmatter round-trip and observation append.
5. `ingest.{py,ts}` — extraction + deterministic append.
6. `query.{py,ts}` — ripgrep + single LLM call with `view` tool.
7. `mcp_server.{py,ts}` — exposes the 6 tools.
8. `prompts/extraction.md`, `prompts/retrieval.md`.

Tests:
- 3 hand-built transcript fixtures with golden entity outputs.
- Round-trip frontmatter for every model.
- One end-to-end: ingest a fixture → query against it → assert citation includes the ingested file.

Out of scope: everything in "deferred to v1."
