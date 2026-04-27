# Brainiac Memory System — Spec v0.5

A personal long-term memory subsystem for an agentic assistant. Stores knowledge as an Obsidian-compatible markdown graph: human-readable, git-tracked, hand-editable. Local-first; MCP server is the only interface to the parent assistant.

> **This is the v1 north star.** What you build first lives in `specs-lite.md` — a stripped-down version that exercises the load-bearing bets without the operational machinery. Port machinery from this spec only when lite hits a real wall.

v0.5 surgical fixes from v0.4: status flip excludes archived; compaction trigger phrasing pinned; staleness ignores brand-new entities; ER step 1 still allows LLM fallback into "create new with disambiguation alias"; `core_review`, `vault_status`, and `compact-journal` schemas spelled out; regen failure has back-off; tool input signatures filled in; off-daemon sync limited to git.

## Storage layout

```
~/memory/
├── _core.md                       # pinned, always-in-context
├── index.md                       # top-level navigation
├── indices/<type>.md              # category indices (rebuilt by ingestion)
├── raw/conversations/             # immutable transcripts
├── episodic/{daily,weekly,monthly}/
├── semantic/<type>/               # entity pages
│   ├── _unresolved/               # ER candidates awaiting review
│   └── _archive/                  # archived observations (per-type folder)
├── .git/
└── .memory/                       # all derived; regeneratable
    ├── entity-index.json
    ├── entity-aliases.json
    ├── er-log.jsonl
    ├── summary-history/<id>/<ts>.md
    ├── anchor-history/<id>.jsonl
    ├── compact-journal/<id>.json  # crash-resume markers
    ├── llm-failures/<stage>/<ts>.json
    ├── gc-log.jsonl
    ├── fts.db                     # SQLite FTS5 over Observations
    ├── locks/<id>.lock            # per-entity fcntl
    ├── ingestion.lock             # cross-device
    └── schema-version
```

Entity types: `person`, `belief`, `preference`, `project`, `place`, `concept`, `event`, `skill`.

## Conventions

- Filenames are ASCII slugs; `id` field equals the filename stem.
- Wikilinks resolve slug-first, path-second:
  - `[[alex-smith]]` → `semantic/people/alex-smith.md`
  - `[[raw/conversations/2026-04-26-1430]]` → vault-relative path
- ISO-8601 dates. Tags as `#tag` or `#tag/sub`.
- Agent emits frontmatter, wikilinks, tags, plain markdown only. No Dataview, Tasks, block refs, callouts, HTML.
- **Confidence scales.** Ordinal `high|medium|low` is canonical for entities, observations, and retrieval. Numeric `0–1` appears only inside `er-log.jsonl`. Mapping: `≥0.85: high`, `0.6–0.85: medium`, `<0.6: low`.
- **Sync transport.** Git only in MVP. iCloud/Dropbox/Syncthing are not supported because the post-merge hook is the only conflict-recovery path. Documented limitation; lift in v1.

## Transcript format

`raw/conversations/<YYYY-MM-DD-HHMM>.md`:

```markdown
---
id: 2026-04-26-1430
started_at: 2026-04-26T14:30:00Z
participants: [user, assistant]
---

## t-0001 user
<turn text>

## t-0002 assistant
<turn text>
```

Turn ids (`t-<seq>`) are referenced by observations.

## Entity page

```yaml
---
id: alex-smith
name: Alex Smith
aliases: [Alex, A.S.]
entity_type: person
tags: [work, founder]
status: active                   # active | dormant | archived
created: 2024-08-12
updated: 2026-04-26
source_count: 14                 # non-invalidated observations
query_count: 3                   # incremented by retrieval; used for GC
confidence: high                 # high | medium | low (Summary trustworthiness)
anchor: Founder of Vercel, met at YC dinner Aug 2024.
anchor_status: current           # current | obsolete
summary_regenerated_at: 2026-04-26T14:00:00Z
relations:
  works_at: [[vercel]]
  collaborator_on: [[personal-assistant]]
schema_version: "0.5"
---

## Summary

<150–300 words. Regenerated during compaction from non-invalidated
Observations only — never from prior Summary.>

## Observations

### 2026-04-26 — Pushed back on local-first
> "He thinks the sync story is always going to be the bottleneck"
**id:** obs-2026-04-26-001
**source:** [[raw/conversations/2026-04-26-1430]]
**source_turn:** t-0042
**event_time:** 2026-04-26
**ingested_at:** 2026-04-26T14:32:11Z
**confidence:** high
**invalidated_by:**
**tags:** [#commitment]
```

Optional sections: `## Open Questions`, `## Evolution` (auto-rendered for `belief`/`preference`), `## Related`.

Observations are reverse-chronological by `ingested_at`. The ingestion driver assigns `id` (`obs-<date>-<seq>`, monotonic per file) and `ingested_at`. `invalidated_by` is set by contradiction detection (§ingestion); never deleted, only archived during compaction. Observation `tags` are user-style hashtags; `#commitment` is reserved for `_core.md` triggers.

### Anchor semantics

Advisory, not blocking. Compaction's regenerator returns `anchor_consistent: bool`. If false, `anchor_status` flips to `obsolete` and an entry is appended to `anchor-history/<id>.jsonl`. Confidence is **not** auto-downgraded. The entity surfaces via `vault_status` and `list_anchor_obsolete`.

`update_anchor` appends the prior anchor to `anchor-history/<id>.jsonl` with timestamp and reason, then sets the new anchor with `anchor_status: current`.

### Stale-summary signal

`summary_regenerated_at` is updated on every Summary regeneration. Computed live for entities with `source_count > 0` only:

```
summary_stale = any(obs.ingested_at > summary_regenerated_at and obs.invalidated_by is empty)
```

Brand-new entities (no observations yet, or pre-first-compaction) are never stale. Tier 3 treats `summary_stale: true` as a forcing condition — either include the diff observations or escalate.

### `_core.md`

Always-in-context pinned file: identity, active projects, active commitments, open loops, communication preferences, plus a `## Review Queue` section for pending anchor/unresolved items. Hard cap 1500 tokens. Edited only via `str_replace`/`insert`, never by ingestion.

`consolidate` returns a `core_review` payload listing candidate edits when:

- a `project` was created or its `lifecycle` changed
- a `#commitment` observation was added or invalidated
- a `preference` or `belief` entity was **created** (first-touch — even though no Summary yet, the source observation is enough to seed)
- a `preference` Summary was regenerated with `anchor_status: current`
- the user explicitly asked

`core_review` schema:

```json
[{"type":"insert"|"replace"|"remove",
  "section":"<heading>",
  "anchor":"<exact line, used as str_replace target>",
  "proposed":"<text>",
  "reason":"<why>",
  "source_entity":"<id>"}]
```

The parent assistant calls `str_replace`/`insert` on `_core.md` to apply each entry. Optionally surfaces the diff to the user before applying. Required to act before the next user turn.

## Ingestion

Triggered by an explicit `consolidate` MCP call. The **ingestion driver** orchestrates and is responsible for ids, timestamps, locks, the er-log, and the compact-journal.

`consolidate` returns `{ingested: int, core_review: [...], unresolved_added: int, anchor_obsolete: [<id>...]}`, where `ingested` is the count of observations actually appended (excludes candidates routed to `_unresolved/`).

1. **Salience filter** — local model, JSON output `[{turn_id, keep, reason}]`. Keep first-person (user) assertions, names, decisions, preferences, corrections, user-tagged turns. Drop greetings, tool I/O, neutral assistant turns. **Keep on tie.** Extraction (step 2) sees only `keep: true` turns.

2. **Candidate extraction** — local model produces:
   ```json
   {"candidate_id":"cand-001","type":"person","subject_string":"Alex",
    "headline":"...","quote":"...","event_time":"2026-04-26",
    "source_turn":"t-0042","confidence":"high",
    "candidate_relations":[{"predicate":"works_at","object_string":"Vercel"}],
    "tags":[]}
   ```

3. **Entity resolution** — for each candidate:
   1. Exact alias match against `entity-aliases.json`. **Single match → resolved.** **Multiple matches → fall through to step 3** (do not auto-route to `_unresolved/`); the LLM fallback gets a chance to identify a third entity.
   2. Slug match (canonicalize `subject_string`) against ids. Same single/multi rule.
   3. LLM fallback: candidate + ±2 turn context + entities-of-same-type list. Returns `{matched_id, confidence, alternatives}`. May propose a new entity by returning `matched_id: null, suggested_alias: "Alex (coworker)"`.
   4. Threshold (default 0.85): below → `_unresolved/`. `matched_id == null` → create new entity with `suggested_alias` appended (or the bare `subject_string` if none) so the *next* mention isn't ambiguous. `matched_id` set with confidence below threshold → `_unresolved/`.
   5. Log to `er-log.jsonl`.

   **Relation-object typing.** When a relation auto-creates an object entity, the LLM fallback in step 3 also returns its `entity_type`. If unsure, defaults to `concept`.

4. **Append + invalidate** — under per-entity lock:
   1. Driver assigns `obs-<date>-<seq>` and `ingested_at`.
   2. **Contradiction detection** (LLM): pass candidate + target's last `min(30, file_length)` non-invalidated observations. Returns `{contradicts: [obs_id]}`. Set each prior's `invalidated_by` to the new observation's id. Multi-target permitted. Chains followed by Evolution rendering (§5.5).
   3. Insert observation at top of `## Observations`.
   4. Resolve `candidate_relations.object_string` through ER (full pipeline). Add resolved edges to `relations:` (additive, deduped on `(predicate, object_id)`). Unresolved relation objects → `_unresolved/`.
   5. Update `updated`, recount `source_count`, union `aliases`. **If `status == dormant`, set to `active`.** (`archived` requires explicit `unarchive_entity`.) On the very first observation appended to a new entity, set `summary_regenerated_at = ingested_at` to keep the entity from being vacuously stale. Evaluate compaction triggers; queue if tripped.

5. **Compaction** (queued, off the hot path; resumable via `compact-journal/<id>.json`) — when any of:
   - `source_count > 25`
   - file > 3000 words
   - **count of observations whose `invalidated_by` was newly set since last compaction ≥ 5** (mass invalidation by a single new observation counts each invalidated prior individually — so one belief flip can immediately trip the trigger)
   - `confidence == low` AND ≥5 new observations since last compaction AND last 3 regen attempts in `llm-failures/regen/<id>/` are not within the past 7 days (back-off; prevents tight loop on persistent failure).

   1. Write journal `{step: "snapshot"}` → snapshot Summary to `summary-history/<id>/<ts>.md`.
   2. Write journal `{step: "regenerate"}` → call regenerator with non-invalidated observations chronologically (oldest first; reversing storage order) and the anchor as a consistency check. **Prior Summary not in context.** Returns `{summary, anchor_consistent: bool, confidence_signal: "raise"|"hold"|"lower", reason}`.
   3. Write journal `{step: "apply"}` → write Summary; set `summary_regenerated_at: now`. If `anchor_consistent: false`: set `anchor_status: obsolete`, append entry to `anchor-history/<id>.jsonl`. Apply `confidence_signal`: `raise` → high; `hold` → unchanged; `lower` → drop one level.
   4. Write journal `{step: "archive"}` → move invalidated observations and observations beyond the most recent 10 (by `ingested_at`) to `semantic/<type>/_archive/<id>.md`, leaving one-line stubs.
   5. Write journal `{step: "evolution"}` → for `belief`/`preference`, render `## Evolution` from invalidator chains and stars. **Fan-in case** (one new observation invalidates ≥2 priors): collapse into a single line `<earliest_priors_date> → <new_obs_date> — <was-position> ([[#obs-...]] ×N superseded by [[#obs-new]])`. **Linear chains** render as before. Stub-archived links remain valid via section anchors.
   6. Delete journal on success. On crash, the next compaction reads the journal and resumes from the next unwritten step.

   When an observation is invalidated, its `relations` contributions are not retroactively pruned from `relations:` — the edge persists unless the new (invalidator) observation supplies a contradicting relation, which goes through the same additive-dedup rule.

`compact-journal/<id>.json` schema:

```json
{"id":"alex-smith","started_at":"2026-04-27T03:00:00Z",
 "last_step":"regenerate","snapshot_path":"summary-history/alex-smith/...",
 "regenerator_output":{"summary":"...","anchor_consistent":true,
                        "confidence_signal":"hold","reason":"..."},
 "error":null}
```

Presence of the file with `last_step != "evolution"` means resumable; deletion is the success marker.

**Cold rebuild** (manual `cold_rebuild` tool): gather all turns referenced by any non-invalidated observation's `(source, source_turn)` plus ±2 turn context, order chronologically, chunk if over context budget with map-reduce reconciliation, regenerate Summary. Updates `summary_regenerated_at`. Does not modify Observations.

### `_unresolved/` file

```yaml
---
candidate_id: cand-001
subject_string: Alex
type: person
ambiguous_with: [alex-smith, alex-jones]   # if step-1/2 collision and LLM also unsure
er_decision_id: er-2026-04-26-001
---
## Candidate Observation
<§observation format>
## Alternatives Considered
- [[alex-smith]] (score 0.71)
```

Resolved by user or assistant via `resolve_unresolved`/`move_observation`/`split_entity`.

### New-entity initial frontmatter

`source_count: 0`, `query_count: 0`, `confidence: medium`, `anchor: ""`, `anchor_status: current`, `summary_regenerated_at: <now>`, `relations: {}`, `aliases: [<subject_string>, <suggested_alias>?]`, `status: active`, `schema_version: <current>`.

### `er-log.jsonl` schema

```json
{"ts":"...","decision_id":"er-...","transcript":"...","turn_id":"t-...",
 "candidate":{"subject_string":"Alex","type":"person","headline":"..."},
 "decision":"matched|refused|created|ambiguous",
 "matched_id":"alex-smith","alternatives":[{"id":"...","score":0.71}],
 "confidence":0.92,"observation_id":"obs-...","annotation":null}
```

`annotation` is filled when a user later corrects the decision.

## LLM call discipline

Six stages call an LLM and expect structured output: salience, candidate extraction, ER fallback, contradiction detection, Summary regeneration, router. All follow the same contract:

- **Constrained decoding** (JSON schema or grammar — llama.cpp grammars or `outlines`-equivalent). Schema in `schemas/<stage>.json`.
- **Retry once** on parse failure with the same prompt.
- **On second failure**: write raw output to `.memory/llm-failures/<stage>/<ts>.json` and apply the stage's null behavior:
  - Salience: keep the turn (fail-open).
  - Extraction: skip the turn; proceed.
  - ER fallback: route to `_unresolved/`.
  - Contradiction: skip — do not set `invalidated_by`. Re-evaluated on next compaction.
  - Summary regen: keep prior Summary, set `confidence: low`, retry on next compaction (subject to back-off — see §5 trigger).
  - Router: set `escalate: true` and pass through.
- **Confidence floor** for contradiction detection: only set `invalidated_by` when the model asserts it with high confidence.

Prompts live in `prompts/<stage>.md`. Both prompts and schemas are versioned with the spec; output-shape changes require a `schema_version` bump.

## Retrieval

Every tier returns `{answer?, files, citations, tier, confidence}`. Parent assistant sets `max_tier` per call (`fast` stops at Tier 3, `thorough` allows Tier 4; default `fast`).

| Tier | Mechanism                                | p50      | Escalation trigger                   |
|-----:|------------------------------------------|----------|--------------------------------------|
|    1 | Alias / date / tag exact match           | <50ms    | zero matches OR ambiguous (≥2 ids)   |
|    2 | ripgrep / FTS5 over Observation bodies   | <150ms   | 0 hits, or >5 (refinement needed)    |
|    3 | Local LLM router with cached index       | ~1200ms  | router sets `escalate: true`, OR any cited entity has `summary_stale: true` and `max_tier == thorough` |
|    4 | Cloud sub-agent, full read-only nav      | 3–8s     | —                                    |

Retrieval `confidence` = min over cited entities' frontmatter `confidence`, downgraded one level if any cited entity has `summary_stale: true`.

**Tier 3 cache strategy.** Cached prefix = `index.md` + `indices/*.md` + condensed entity index (`id`, `name`, `aliases`, `entity_type`, `tags`, one-line `anchor`, `status`). Volatile fields (`updated`, `source_count`, `query_count`, `summary_regenerated_at`) excluded from prefix. Prefix invalidates on entity create/delete/rename/alias/anchor/status/tag changes only. Volatile suffix = query + Tier 1/2 hits.

**Stale-summary handling.** Before returning, the orchestrator checks each cited entity's `summary_stale`. If any are stale, it appends the diff observations (those with `ingested_at > summary_regenerated_at`) to `citations` and downgrades retrieval confidence.

Router output:

```json
{"files":["semantic/people/alex-smith.md"],
 "expand_relations":[{"from":"alex-smith","predicates":["works_at"],"max_hops":1}],
 "escalate":false,"reason":"..."}
```

Expansion is a deterministic graph walk over the entity index — no extra LLM call. Max 2 hops globally.

`indices/<type>.md` is rebuilt by the ingestion driver on entity create/rename/archive within that type. `fts.db` updates incrementally on Observation append/invalidate/archive; full rebuild on `cold_rebuild` or migration.

Each cited entity's `query_count` increments on retrieval (all tiers).

## Agent interface (MCP)

The memory subsystem is a local MCP server.

| Tool                  | Inputs / Behavior                                                                          |
|-----------------------|--------------------------------------------------------------------------------------------|
| `view`                | `(path, lines?)` — list directory or read file.                                            |
| `query`               | `(query, max_tier?)` — run cascade.                                                        |
| `vault_status`        | `()` — returns `{anchor_obsolete: [{id,reason,ts}], unresolved: [{path,subject,since}], dormancy_proposals: [{id,since}], compaction_pending: [{id,trigger}], stale_summaries: [{id,diff_count}]}`. Called at session start. |
| `list_unresolved`     | `()` — list pending ER candidates.                                                          |
| `list_anchor_obsolete`| `()` — list entities with `anchor_status: obsolete`.                                        |
| `create`              | `(path, content)` — create file (errors if exists).                                        |
| `str_replace`         | `(path, old, new)` — replace exact substring.                                              |
| `insert`              | `(path, line, text)` — insert at line N.                                                   |
| `rename`              | `(old_path, new_path)` — triggers vault-wide wikilink rewrite + index update.              |
| `delete`              | `(path)` — restricted to `_unresolved/`.                                                    |
| `consolidate`         | `(transcript_path)` — run §ingestion; returns `{ingested, core_review, unresolved_added, anchor_obsolete}`. |
| `compact`             | `(id)` — run §compaction (idempotent via journal).                                          |
| `cold_rebuild`        | `(id)` — regenerate Summary from raw transcripts.                                          |
| `move_observation`    | `(from_id, obs_id, to_id)` — move obs across entities. Updates `source_count` on both, FTS for both, `er-log` annotation. Queues both for compaction. |
| `split_entity`        | `(id, partition: {new_id, obs_ids[], aliases[]})` — split into two; primary keeps anchor; rebuilds entity-index, aliases, FTS; resets `summary_regenerated_at` on both. |
| `merge_entities`      | `(from_id, to_id)` — merge `from` into `to`; unions aliases/observations/relations; keeps `to`'s anchor; rewrites wikilinks vault-wide; rebuilds derived state. |
| `update_anchor`       | `(id, new_anchor, reason)` — append prior to `anchor-history/<id>.jsonl`; set `anchor_status: current`. |
| `archive_entity`      | `(id)` — set `status: archived`. Removes from default retrieval prefix.                    |
| `unarchive_entity`    | `(id)` — set `status: active`. Re-includes in prefix and `indices/<type>.md`.              |
| `resolve_unresolved`  | `(unresolved_path, decision: {to_id?, new_id?, aliases?})` — append candidate observation to chosen entity; annotate `er-log`; delete the unresolved file. |
| `vault_gc`            | `(dry_run?)` — dormancy/retention pass; outputs `gc-log.jsonl`.                            |

**Hooks.** `rename` triggers vault-wide wikilink rewrite (skipping `raw/` and fenced code blocks) + index update, atomic via temp-rewrite-then-swap. Post-git-merge hook re-sorts Observations descending by `ingested_at` and rederives the entity index.

**System prompt protocol.**
- Call `vault_status` at session start; surface non-empty `anchor_obsolete` and `unresolved` to the user.
- `view _core.md` and the relevant directory before mutating.
- After each `consolidate`, act on `core_review` before the next user turn.
- `raw/` is read-only.
- Cite file paths when surfacing memory content.

## Operational notes

**Locking.** Per-entity fcntl (`.memory/locks/<id>.lock`) covers intra-host races. Cross-device ingestion is single-writer via `ingestion.lock`. Lock-acquisition timeout 5s; on timeout the candidate is written to `_unresolved/`.

**Off-daemon edits.** Hand-edits via Obsidian (including mobile) bypass locks. **Sync transport must be git** in MVP — non-git syncs (iCloud, Dropbox, Syncthing) have no recovery path because the post-merge hook is the conflict surface. Documented limitation.

**Merge conflicts.** Frontmatter — human resolves. Observations — union, post-merge hook reorders descending by `ingested_at`. Summary — keep both as `## Summary` and `## Summary (incoming)`; human resolves.

**Schema migrations.** `.memory/migrations/<from>-to-<to>.{py,ts}`. Per-read upgrade: any read at stale `schema_version` migrates in-memory before mutation, persists on next write. **0.4 → 0.5:** entities without `summary_regenerated_at` get `summary_regenerated_at = updated`; `anchor_status` defaults to `current` if missing.

**Retention.** `raw/`, `episodic/`, `_archive/`, `anchor-history/` kept indefinitely. `er-log.jsonl` rotated yearly. `summary-history/<id>/` capped at 20 most recent. `compact-journal/` deleted on success. `llm-failures/` rotated monthly. Pruning via `vault_gc`.

**Dormancy & GC.** `vault_gc` sets `dormant` on entities with `source_count == 1`, no inbound `relations`, `query_count == 0`, age > 30d. Dormant for 180+ days proposes archival via `dormancy_proposals` (never auto). Status returns to `active` automatically on next observation only when previously `dormant`; `archived → active` requires explicit `unarchive_entity`.

**Auditability.** Five trails: git history, `er-log.jsonl`, `summary-history/`, `anchor-history/`, `compact-journal/` (live or post-mortem).

## Open questions

1. Local model + quantization (Qwen 2.5 7B vs Llama 3.1 8B vs other).
2. Threshold tuning: ER (0.85), compaction (25/3000/5).
3. Salience and router prompts — design with fixtures.
4. Embeddings index for ER canonicalization only — currently rejected; revisit if alias drift hurts.
5. Auto end-of-day daily-note generation vs manual.
6. Mobile capture via `inbox/` folder.
7. Self-benchmark against LOCOMO / LongMemEval after MVP.
8. AST-aware markdown editor (remark / mistletoe) for safer mutations than raw `str_replace`.
9. Tokenizer pin for `_core.md` cap.
10. Implementation language: Python or TypeScript.
11. Whether Tier 3 prefix-vs-suffix split is worth its complexity — measure with real workload.
12. Encryption-at-rest for `~/memory/` (this is therapy-and-relationships data in plaintext).
13. Prompt versioning discipline beyond `schema_version` — separate `prompt_version` per stage.
14. `model_version` recorded on observations for cross-model comparability.
