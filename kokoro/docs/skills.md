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
- **Proposals** go through the shared guard (durable anti-nag via `SkillProposalDecision`; one-pending-per-chat across all confirmation kinds) with version-scoped signatures, and the approved actions are dispatch-only (`updateSkill`, `disableSkill`, `mergeSkills`) with compare-and-set writes that require the matching `version` **and** `enabled: true` — content fields only, so a curation can never rename, re-enable, or change `source`, and a skill archived from the dashboard (which flips `enabled` without a version bump) can't be rewritten at its stale version (`state_conflict`; archiving an already-archived skill is a success no-op). A merge preflights every absorbee before writing anything (a stale absorbee cancels the whole merge with nothing changed), then applies the survivor's merged body and archives the absorbees after; archive disables, never deletes. Every proposal bubble shows the actual values being approved — body before/after plus `field: current → proposed` lines for metadata changes.
- **Stamping**: a reviewed candidate gets `lastReviewedAt` set afterwards only when its review reached a terminal outcome (no action, proposal raised, durably declined, or invalid action) — a candidate whose proposal was deferred by the per-run cap or suppressed by a pending confirmation stays unstamped and re-enters next cycle. A no-action verdict stamps, so the cooldown starts and the next cycle reviews fresh skills.

Scheduler in `apps/bot/src/scheduler/skill-review.ts` (weekly; first run ~15 min after boot, staggered after the routine self-review so routines get the one pending-proposal slot first — overlapping passes are serialized FIFO by the shared per-chat runner, so the stagger shapes ordering, not correctness). Full mechanics in [ai-layer.md](ai-layer.md#automated-skill-curation-pass-always-on).

## Dashboard

The Kokoro dashboard exposes `/skills` and `/skills/[id]`:

- list/search/filter by enabled/manual/distilled
- create manual skills
- toggle enabled
- edit body, triggers, tags, source, description, and name
- delete skills

API routes live under `apps/dashboard/src/app/api/skills`. Content edits bump `version` (which also clears `lastReviewedAt` — the edited skill re-enters curation); enabled-only toggles do neither. `linkedRoutineIds` must be Mongo ObjectId-shaped strings.

## Routines Relationship

Routines are executable workflows: they run as independent LLM tasks, accept parameters, can be scheduled, and write `RoutineLog` rows. Skills are context packages: they are searched/read and then applied to the current reasoning path or embedded into a routine prompt.

When drafting or refining a routine, the model should search/read relevant skills first and fold durable guidance into the prompt. This keeps routine prompts aligned with reusable style/policy/procedure without turning every skill into an automation.
