import { generateObject } from "ai";
import { z } from "zod";
import {
  listChatIdsWithSkills,
  listEnabledSkillsForChat,
  markSkillsReviewed,
  skillNeedsReview,
  type ISkill,
} from "@kokoro/db";
import { logger, runWithSpan } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import type { AdapterRegistry } from "../platform/registry";
import { getModel, getModelName, ModelTier } from "../ai/provider";
import { trackUsage } from "../ai/token-tracker";
import {
  proposeSkillArchive,
  proposeSkillMerge,
  proposeSkillRefinement,
  type SkillContentPatch,
} from "../ai/tools/skill-refinements";
import type { ProposalResult } from "../ai/tools/proposal-guard";
import { runReviewForEachChat } from "./chat-review-runner";

/**
 * Weekly skill curation (the Hermes-style "curator"): skills are prompt
 * context, so a stale or duplicated skill quietly degrades every future
 * conversation. This pass reviews the library and proposes refine / archive /
 * merge actions through the same gated approval rail as the routine
 * self-review — nothing changes without a tap on Approve.
 *
 * Unlike routines, skills have no run log, so the mechanical pre-filter
 * (`skillNeedsReview`, facts-only) keys on recency: never-reviewed skills and
 * skills gone stale since their last review. One Smart-tier LLM call covers a
 * whole chat (the curator needs the candidates side-by-side to spot overlap),
 * vs the routine review's call-per-routine.
 */

// At most one confirmation of ANY kind can be pending per chat (the one-tap
// iMessage invariant), so a run raises at most one; remaining actions wait for
// the next cycle.
const MAX_PROPOSALS_PER_RUN = 1;
// Cap on candidates given to the single review call — bounds the prompt (full
// bodies are included) and keeps the first-ever run, where every existing
// skill is never-reviewed, from dumping the whole library into one call.
const MAX_SKILLS_PER_REVIEW = 8;
// The LLM ranks its findings; with one proposal slot per run, anything past a
// few backups is wasted output.
const MAX_ACTIONS = 3;

// Min/max bounds mirror the dispatcher's `updateSkillArgs`/`mergeSkillsArgs`
// (.min(1) on every string) so the JSON schema the model sees already forbids
// the blank values the Approve would reject. Belt only — `applyAction` still
// normalizes whitespace the schema can't catch.
const skillActionSchema = z.object({
  action: z.enum(["refine", "archive", "merge"]),
  skillName: z.string().describe("Name of the skill to act on; for a merge, the surviving skill."),
  newDescription: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Refine/merge: replacement one-line description (max 500 chars)."),
  newBody: z
    .string()
    .min(1)
    .max(6000)
    .optional()
    .describe(
      "The complete replacement body (max 6000 chars). Required for a merge; for a refine, provide it only when the body should change.",
    ),
  newTriggers: z.array(z.string().min(1).max(140)).max(20).optional(),
  newTags: z.array(z.string().min(1).max(140)).max(20).optional(),
  absorbNames: z
    .array(z.string())
    .max(5)
    .optional()
    .describe("Merge only: names of the skills to fold into the survivor (they get archived)."),
  rationale: z.string().describe("One line on why — shown to the user on the approval bubble."),
});

const skillReviewSchema = z.object({
  actions: z
    .array(skillActionSchema)
    .max(MAX_ACTIONS)
    .describe("Curation actions, most important first. Empty for a healthy library."),
});

type SkillReviewDecision = z.infer<typeof skillReviewSchema>;
type SkillReviewAction = z.infer<typeof skillActionSchema>;

const REVIEW_SYSTEM = `You curate one chat's skill library. Skills are saved procedural notes — preferences, heuristics, operating instructions — loaded as context by an AI assistant, so a stale or duplicated skill quietly degrades every future conversation.

Judge each skill under review on:
- Accuracy: does the body still read true, or does it carry stale dates, dead references, one-off facts, or contradictions?
- Value: is it durable, reusable guidance — or a note that was never worth keeping?
- Overlap: does it duplicate another skill under review so closely that one merged skill would serve better?

Return at most ${MAX_ACTIONS} actions, most important first — an empty list is the correct answer for a healthy library:
- "refine": rewrite content in place. Provide only the fields that should change (newBody / newDescription / newTriggers / newTags); omitted fields keep their current value. Fix real problems you can see — never invent facts.
- "archive": disable the skill (it is not deleted and can be re-enabled). For skills that are obsolete, superseded, or were never used and read like one-offs.
- "merge": fold duplicates into one survivor. skillName is the survivor, absorbNames are the skills folded in (they get archived), and newBody must be the complete merged content preserving everything still valuable from all of them.

Only skills listed under "Skills under review" may be named in an action — the catalog is context for spotting overlap, nothing more. Be conservative: prefer no action over a speculative rewrite. Every action needs a one-line rationale; the user sees it and each action applies only if they approve.`;

function describeUsage(skill: ISkill): string {
  const lastUsed = skill.lastUsedAt ? skill.lastUsedAt.toISOString().slice(0, 10) : "never";
  return `used ${skill.usageCount}×, last ${lastUsed}, created ${skill.createdAt.toISOString().slice(0, 10)}`;
}

function buildReviewUser(allSkills: ISkill[], candidates: ISkill[], now: Date): string {
  const candidateIds = new Set(candidates.map((s) => s.id));
  const catalog = allSkills
    .map(
      (s) =>
        `- ${s.name} — ${s.description} (${describeUsage(s)})${candidateIds.has(s.id) ? " [under review]" : ""}`,
    )
    .join("\n");
  const detail = candidates
    .map((s) =>
      [
        `### ${s.name} (v${s.version}, ${describeUsage(s)})`,
        `Description: ${s.description}`,
        s.triggers.length > 0 ? `Triggers: ${s.triggers.join(", ")}` : null,
        s.tags.length > 0 ? `Tags: ${s.tags.join(", ")}` : null,
        `Body:`,
        s.body,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    )
    .join("\n\n");
  return [
    `Today is ${now.toISOString().slice(0, 10)}.`,
    ``,
    `Full skill catalog (context only):`,
    catalog,
    ``,
    `Skills under review (full content — only these may be refined, archived, or merged):`,
    ``,
    detail,
  ].join("\n");
}

async function reviewSkills(
  chatId: string,
  allSkills: ISkill[],
  candidates: ISkill[],
  now: Date,
): Promise<SkillReviewDecision> {
  const result = await generateObject({
    model: getModel(ModelTier.Smart),
    schema: skillReviewSchema,
    system: REVIEW_SYSTEM,
    messages: [{ role: "user", content: buildReviewUser(allSkills, candidates, now) }],
    temperature: 0.2,
    abortSignal: AbortSignal.timeout(60_000),
  });

  trackUsage("skill-review", getModelName(ModelTier.Smart), result.usage, { chatId });

  return result.object;
}

/** Trim an optional one-line field; a blank value reads as "no change", never
 * an intentional clear — the dispatcher's `.min(1)` (untrimmed) would accept
 * the bubble but fail the Approve. */
function normalizeLine(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Trim list items and drop blanks (which the dispatcher's per-item `.min(1)`
 * would reject on Approve). A provided-but-all-blank list is noise → treated
 * as omitted; an explicit `[]` passes through (a legitimate clear). */
function normalizeList(items: string[] | undefined): string[] | undefined {
  if (items === undefined) return undefined;
  const cleaned = items.map((item) => item.trim()).filter((item) => item.length > 0);
  return cleaned.length === 0 && items.length > 0 ? undefined : cleaned;
}

/**
 * Map one LLM action onto the matching proposal core. Returns null (after a
 * warn) for an action that fails validation — an unknown skill name, a refine
 * with no content fields, a malformed merge — rather than throwing, so the
 * caller can fall through to the LLM's next-ranked action.
 */
async function applyAction(
  chatId: string,
  adapter: PlatformAdapter,
  byName: Map<string, ISkill>,
  action: SkillReviewAction,
): Promise<ProposalResult | null> {
  const skill = byName.get(action.skillName);
  if (!skill) {
    logger.warn(
      { chatId, skillName: action.skillName, action: action.action },
      "Skill review named a skill outside the reviewed set — skipping",
    );
    return null;
  }

  // Normalize the LLM's content fields before they reach a proposal core:
  // despite the schema hints, a blank/padded field can still arrive, and the
  // dispatcher schemas would raise a bubble whose Approve then fails
  // (invalid_args). A blank field degrades to "no change" instead.
  const newDescription = normalizeLine(action.newDescription);
  const newTriggers = normalizeList(action.newTriggers);
  const newTags = normalizeList(action.newTags);

  switch (action.action) {
    case "refine": {
      const patch: SkillContentPatch = {
        ...(newDescription !== undefined ? { description: newDescription } : {}),
        // Whitespace-only body → omitted: the refine core treats a blanking
        // body as an error, but "no body change" keeps the rest of the patch.
        ...(action.newBody?.trim() ? { body: action.newBody } : {}),
        ...(newTriggers !== undefined ? { triggers: newTriggers } : {}),
        ...(newTags !== undefined ? { tags: newTags } : {}),
      };
      if (Object.keys(patch).length === 0) {
        logger.warn(
          { chatId, skillName: skill.name },
          "Skill review returned a refine without any content fields — skipping",
        );
        return null;
      }
      return proposeSkillRefinement({ chatId, adapter, skill, patch, rationale: action.rationale });
    }

    case "archive":
      return proposeSkillArchive({ chatId, adapter, skill, rationale: action.rationale });

    case "merge": {
      // Dedupe rather than reject a repeated absorbName — the intent (fold
      // that skill in once) is unambiguous, and downstream the proposal core
      // and the dispatcher both hard-reject duplicate absorbees.
      const absorbNames = [...new Set(action.absorbNames ?? [])];
      if (absorbNames.length === 0 || !action.newBody?.trim()) {
        logger.warn(
          { chatId, skillName: skill.name, absorbCount: absorbNames.length },
          "Skill review returned a merge without absorbNames or a merged body — skipping",
        );
        return null;
      }
      const absorbed: ISkill[] = [];
      for (const name of absorbNames) {
        const absorbee = byName.get(name);
        if (!absorbee || absorbee.id === skill.id) {
          logger.warn(
            { chatId, skillName: skill.name, absorbName: name },
            "Skill review merge named an invalid absorbee — skipping",
          );
          return null;
        }
        absorbed.push(absorbee);
      }
      return proposeSkillMerge({
        chatId,
        adapter,
        survivor: skill,
        absorbed,
        patch: {
          body: action.newBody,
          ...(newDescription !== undefined ? { description: newDescription } : {}),
          ...(newTriggers !== undefined ? { triggers: newTriggers } : {}),
          ...(newTags !== undefined ? { tags: newTags } : {}),
        },
        rationale: action.rationale,
      });
    }
  }
}

/**
 * Curate one chat's skill library: select due candidates with the facts-only
 * pre-filter, run ONE constrained LLM pass over them (full bodies, plus the
 * catalog for overlap context), then raise the LLM's ranked actions through the
 * gated proposal cores until one lands.
 *
 * Stamping is disposition-aware: a candidate is stamped `lastReviewedAt` only
 * when its outcome this run is TERMINAL — no action targeted it, its proposal
 * was raised, the user durably declined it, or the action was malformed /
 * rejected by a core's validation (those re-derive the same dead end every
 * time). A candidate whose action was deferred by the one-proposal cap,
 * transiently suppressed by another pending confirmation, or lost to a thrown
 * error keeps its un-reviewed status, so the next cycle picks the work back up
 * instead of burying it under the 30-day cooldown. Returns the number of
 * proposals raised. Exported for testing.
 */
export async function reviewChatSkills(chatId: string, adapter: PlatformAdapter): Promise<number> {
  const skills = await listEnabledSkillsForChat(chatId);
  if (skills.length === 0) return 0;

  const now = new Date();
  const due = skills.filter((s) => skillNeedsReview(s, now));
  if (due.length === 0) return 0;

  // Never-reviewed first (oldest created first — they've waited longest), then
  // stale re-reviews by oldest activity. Cap so the prompt stays bounded; the
  // tail is picked up next cycle once these are stamped.
  const lastActivity = (s: ISkill) => (s.lastUsedAt ?? s.createdAt).getTime();
  const neverReviewed = due
    .filter((s) => !s.lastReviewedAt)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const staleAgain = due
    .filter((s) => s.lastReviewedAt)
    .sort((a, b) => lastActivity(a) - lastActivity(b));
  const candidates = [...neverReviewed, ...staleAgain].slice(0, MAX_SKILLS_PER_REVIEW);
  if (candidates.length < due.length) {
    logger.info(
      { chatId, due: due.length, reviewing: candidates.length },
      "Skill review capped this run's candidates — remainder deferred to the next cycle",
    );
  }

  let decision: SkillReviewDecision;
  try {
    decision = await runWithSpan("skill.selfReview", () =>
      reviewSkills(chatId, skills, candidates, now),
    );
  } catch (error) {
    logger.error({ error, chatId }, "Skill review LLM pass failed");
    return 0;
  }

  const byName = new Map(candidates.map((s) => [s.name, s]));

  // Candidates whose pending curation work was NOT terminally handled this run
  // (cap-deferred, transiently suppressed, or lost to a throw) are left
  // un-stamped below so the next cycle re-derives the action instead of
  // cooling it down for 30 days.
  const unstampedIds = new Set<string>();
  const skillIdsTouchedBy = (action: SkillReviewAction): string[] =>
    [action.skillName, ...(action.absorbNames ?? [])]
      .map((name) => byName.get(name)?.id)
      .filter((id): id is string => id !== undefined);

  let raised = 0;
  for (const action of decision.actions) {
    if (raised >= MAX_PROPOSALS_PER_RUN) {
      // Deferred by the one-proposal cap — still-pending work, not an outcome.
      for (const id of skillIdsTouchedBy(action)) unstampedIds.add(id);
      continue;
    }
    try {
      const result = await applyAction(chatId, adapter, byName, action);
      if (result?.proposed) {
        raised++;
      } else if (result?.suppressedByPending) {
        // Another confirmation already holds the chat's slot — transient, so
        // the action must survive to the next cycle.
        for (const id of skillIdsTouchedBy(action)) unstampedIds.add(id);
        logger.debug(
          { chatId, skillName: action.skillName, action: action.action, reason: result.reason },
          "Skill review proposal suppressed by a pending confirmation — will retry next cycle",
        );
      } else if (result) {
        // Durable decline or core validation rejection — terminal: re-deriving
        // it next cycle would reach the same dead end, so the stamp stands.
        logger.debug(
          { chatId, skillName: action.skillName, action: action.action, reason: result.reason },
          "Skill review proposal suppressed",
        );
      }
      // result === null (malformed action) is likewise terminal — stamped.
    } catch (error) {
      for (const id of skillIdsTouchedBy(action)) unstampedIds.add(id);
      logger.error(
        { error, chatId, skillName: action.skillName, action: action.action },
        "Failed to raise skill-review proposal",
      );
    }
  }

  // Stamp AFTER the proposals so a crash mid-run re-reviews rather than
  // silently skipping; best-effort because a failed stamp only means an extra
  // look next cycle. Only terminally-handled candidates are stamped (see the
  // function doc), and each stamp carries the version this pass actually read —
  // a skill edited while the pass ran stays unstamped (the edit cleared its
  // stamp; rewriting it would describe content this review never saw).
  await markSkillsReviewed(
    chatId,
    candidates
      .filter((s) => !unstampedIds.has(s.id))
      .map((s) => ({ id: s.id, version: s.version })),
    now,
  ).catch((error) => {
    logger.warn({ error, chatId }, "Failed to stamp skills as reviewed");
  });

  return raised;
}

/**
 * Curate every chat that owns enabled skills, via the shared per-chat review
 * runner (adapter resolution + per-chat failure isolation).
 */
export async function runSkillSelfReview(registry: AdapterRegistry): Promise<void> {
  await runReviewForEachChat({
    label: "skill-review",
    registry,
    listChatIds: listChatIdsWithSkills,
    review: reviewChatSkills,
  });
}
