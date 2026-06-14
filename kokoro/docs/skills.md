# Skills

Skills are Kokoro's reusable procedural context layer. They store durable guidance that should shape future work: preferences, heuristics, writing style, project rules, and operating procedures. A skill does not execute and does not schedule anything; routines remain the executable workflow layer.

## Data Model

Stored in MongoDB as `Skill` (`packages/db/src/models/skill.ts`):

- `chatId`, `name`, `description`, `body`
- `triggers`, `tags`
- `enabled`
- `source`: `manual`, `distilled`, or `imported`
- `sourceRef`: optional provenance pointer
- `linkedRoutineIds`: optional routine references
- `version`
- `lastUsedAt`, `usageCount`
- `lastReviewedAt` (stamped by the weekly curation pass; never bumps `updatedAt`/`version`; cleared by any version-bumping edit — the new version was never reviewed)

Skill names are unique per chat. Dashboard and proposal paths enforce lowercase dash names so the model has a stable handle (`meeting-followup-style`).

## AI Tools

Defined in `apps/bot/src/ai/tools/skills.ts`:

- `searchSkills({ query? })` lists enabled skills for the current chat. It returns names, descriptions, triggers, tags, source, and version, but not the full body.
- `readSkill({ name })` returns the full body of an enabled skill and increments usage metadata.
- `proposeSkill({ name, description, body, triggers?, tags? })` raises a tap-to-approve proposal. It never writes directly.

`searchSkills` and `readSkill` are pure reads, so they are available in the normal `allTools` palette and the watcher-safe read-only subset. `proposeSkill` is available only when `ToolContext.conversational === true`.

## Approval Rail

Skill creation uses the same confirmation primitive as routine proposals:

1. `proposeSkill` computes a stable signature from normalized name + body hash.
2. It checks `SkillProposalDecision` (`packages/db/src/models/skill-proposal.ts`) so declined proposals stay quiet past the chat window.
3. It checks the shared one-pending guard — **any** pending confirmation in the chat (a gated action like `sendEmail` just as much as another proposal) suppresses, because iMessage resolves a bare YES/NO only when exactly one confirmation is pending.
4. It raises a pending confirmation with the dispatch-only action `createSkill`.
5. On approve, `dispatchGatedAction("createSkill", ...)` creates an enabled `source: "distilled"` skill.
6. On deny/cancel, `recordProposalDeclineFromConfirmation()` records a declined skill proposal.

`createSkill` is deliberately absent from `GATED_TOOL_NAMES`, so the model cannot bypass `proposeSkill` by calling `requestConfirmation` directly.

## Automated Curation (weekly)

A weekly curator pass reviews each chat's skill library and proposes **refine** / **archive** / **merge** actions through the same approval rail — nothing changes without a tap on Approve. Skills are prompt context, so a stale or duplicated skill quietly degrades every future conversation; the curator is how the library stays accurate without the user doing the gardening.

- **Selection** is facts-only (`skillNeedsReview` in `packages/db/src/models/skill.ts`): a skill is due when never reviewed, or stale (no use in 30 days) and past a 30-day review cooldown. Candidates are capped at 8 per run, never-reviewed first.
- **One LLM call per chat** (`apps/bot/src/services/skill-review.ts`) sees the candidates side-by-side (plus the full catalog as context) so it can spot overlap; it returns up to 3 ranked actions, and an empty list is the expected answer for a healthy library.
- **Proposals** go through the shared guard (durable anti-nag via `SkillProposalDecision`; one-pending-per-chat across all confirmation kinds) with version-scoped signatures, and the approved actions are dispatch-only (`updateSkill`, `disableSkill`, `mergeSkills`) with compare-and-set writes that require the matching `version` **and** `enabled: true` — content fields only, so a curation can never rename, re-enable, or change `source`, and a skill archived from the dashboard (which flips `enabled` without a version bump) can't be rewritten at its stale version (`state_conflict`; archiving an already-archived skill is a success no-op). A merge requires distinct absorbees (a duplicated absorbee is rejected before anything is written) and preflights every absorbee before writing anything (a stale absorbee cancels the whole merge with nothing changed), then applies the survivor's merged body and archives the absorbees after; archive disables, never deletes. Every proposal bubble shows the actual values being approved — body before/after plus `field: current → proposed` lines for metadata changes.
- **Stamping**: a reviewed candidate gets `lastReviewedAt` set afterwards only when its review reached a terminal outcome (no action, proposal raised, durably declined, or invalid action) — a candidate whose proposal was deferred by the per-run cap or suppressed by a pending confirmation stays unstamped and re-enters next cycle. The stamp is version-conditional (it matches only the version the pass actually read), so a skill edited mid-pass is never re-stamped with a verdict about content the pass didn't see. A no-action verdict stamps, so the cooldown starts and the next cycle reviews fresh skills.

Scheduler in `apps/bot/src/scheduler/skill-review.ts` (weekly; first run ~15 min after boot, staggered after the routine self-review so routines get the one pending-proposal slot first — overlapping passes are serialized FIFO by the shared per-chat runner, so the stagger shapes ordering, not correctness). Full mechanics in [ai-layer.md](ai-layer.md#automated-skill-curation-pass-always-on).

## Version History & Rollback

Curation actions (refine / merge) and dashboard content edits **overwrite the live `Skill` doc in place**, so without history a bad approved edit — a refine that dropped something useful, or a merge that fused a survivor's body into mush — would be irrecoverable. (Archive is already safe: it disables, never deletes, and is re-enableable.) `SkillRevision` (`packages/db/src/models/skill-revision.ts`) records the content of every superseded version so any of them can be restored.

- **What's recorded**: a content edit snapshots the about-to-be-overwritten version (name / description / body / triggers / tags) plus provenance — `reason` (`refine` / `merge` / `manual-edit` / `rollback`), `actor` (`curator` / `dashboard`), and the curator's rationale as `note`. **Enabled-only toggles are not recorded** — they change no content and are already recoverable — so the history stays a pure content log. The current version always lives on the `Skill` doc; the timeline is `revisions ∪ live`.
- **The capture seam**: the gated `updateSkill`/`mergeSkills` dispatchers write through `updateSkillIfVersionWithHistory` (`packages/db/src/models/skill.ts`); the dashboard PATCH route calls `snapshotSkillVersion` directly. Either way the pre-edit version is read up front but recorded to history **only after the write succeeds** (best-effort, idempotent on `(skillId, version)`): a rejected edit — a raced/archived CAS miss, or a rename hitting the unique `(chatId, name)` index — writes no revision, so it can neither pollute a version's provenance nor evict a real rollback point at the cap. The only exposure is the narrow window between the committed write and the snapshot, where a hard crash drops one version's history (self-healing on the next edit). The CAS itself is unchanged, so a concurrent edit is still rejected, not clobbered. History is bounded to the newest `MAX_REVISIONS_PER_SKILL` (20) per skill; a hard delete cascades (`deleteSkillRevisions`), but archive leaves it intact.
- **Rollback is just another content edit**: restoring version _N_ snapshots the now-current version first (under `reason: "rollback"`, so the rollback is itself reversible), then writes _N_'s content as a new version. Only content fields move — the name (stable handle) and enabled state are left as they are. It is **user-initiated** (skills have no run-grade, so a regression can't be auto-detected the way a routine's can), surfaced as a **Restore** button per version on `/skills/[id]` and served by `POST /api/skills/[id]/revisions/[version]`.

## Dashboard

The Kokoro dashboard exposes `/skills` and `/skills/[id]`:

- list/search/filter by enabled/manual/distilled
- create manual skills
- toggle enabled
- edit body, triggers, tags, source, description, and name
- delete skills
- view version history and restore a prior version (see [Version History & Rollback](#version-history--rollback))

API routes live under `apps/dashboard/src/app/api/skills`. Content edits bump `version` (which also clears `lastReviewedAt` — the edited skill re-enters curation) and snapshot the pre-edit version to history; enabled-only toggles do neither. `linkedRoutineIds` must be Mongo ObjectId-shaped strings.

## Package Import/Export

Skill packages are versioned JSON bundles for moving procedural context between
Kokoro installs or sharing a curated set of skills with another chat. Packages
remain context-only: importing a package creates `Skill` rows, but does not
create routines, schedule jobs, or grant new tool permissions.

Export all skills from the dashboard API:

```http
GET /api/skills/export
```

Export skills for one chat:

```http
GET /api/skills/export?chatId=<chatId>
```

Import a package into its recorded chat scopes:

```http
POST /api/skills?action=import
```

Import all package items into one chat:

```http
POST /api/skills?action=import&chatId=<chatId>
```

When `chatId` is present on the import URL, every package item is imported into
that chat. Otherwise, each package item's own `chatId` is used. Legacy package
items without `chatId` fall back only when there is exactly one existing chat
scope to infer from; items that still have no target chat are reported in
`errors`.
Imported rows are written as `source: "imported"`; duplicates by `(chatId, name)`
are skipped and returned in the summary instead of failing the whole import.
Empty packages import successfully with a zero-count summary.

Package shape (`version: 1`):

```json
{
  "version": 1,
  "exportedAt": "2026-06-08T00:00:00.000Z",
  "count": 1,
  "skills": [
    {
      "chatId": "chat_123",
      "name": "meeting-followup-style",
      "description": "How to write concise meeting follow-up messages.",
      "body": "Include decisions, owners, deadlines, and open questions.",
      "triggers": ["meeting", "followup", "recap"],
      "tags": ["writing", "crm"],
      "enabled": true
    }
  ]
}
```

`linkedRoutineIds` are deliberately not exported in v1 because routine ObjectIds
are local to a MongoDB database. A future package version can add portable
routine-name links and resolve them during import.

## Routines Relationship

Routines are executable workflows: they run as independent LLM tasks, accept parameters, can be scheduled, and write `RoutineLog` rows. Skills are context packages: they are searched/read and then applied to the current reasoning path or embedded into a routine prompt.

When drafting or refining a routine, the model should search/read relevant skills first and fold durable guidance into the prompt. This keeps routine prompts aligned with reusable style/policy/procedure without turning every skill into an automation.
