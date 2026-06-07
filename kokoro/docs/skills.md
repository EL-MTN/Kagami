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
3. It raises a pending confirmation with the dispatch-only action `createSkill`.
4. On approve, `dispatchGatedAction("createSkill", ...)` creates an enabled `source: "distilled"` skill.
5. On deny/cancel, `recordProposalDeclineFromConfirmation()` records a declined skill proposal.

`createSkill` is deliberately absent from `GATED_TOOL_NAMES`, so the model cannot bypass `proposeSkill` by calling `requestConfirmation` directly.

## Dashboard

The Kokoro dashboard exposes `/skills` and `/skills/[id]`:

- list/search/filter by enabled/manual/distilled
- create manual skills
- toggle enabled
- edit body, triggers, tags, source, description, and name
- delete skills

API routes live under `apps/dashboard/src/app/api/skills`. Content edits bump `version`; enabled-only toggles do not.

## Routines Relationship

Routines are executable workflows: they run as independent LLM tasks, accept parameters, can be scheduled, and write `RoutineLog` rows. Skills are context packages: they are searched/read and then applied to the current reasoning path or embedded into a routine prompt.

When drafting or refining a routine, the model should search/read relevant skills first and fold durable guidance into the prompt. This keeps routine prompts aligned with reusable style/policy/procedure without turning every skill into an automation.
