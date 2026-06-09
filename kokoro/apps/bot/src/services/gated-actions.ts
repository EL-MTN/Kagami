import { z } from "zod";
import { sendEmail } from "./gmail";
import { updateEvent, deleteEvent } from "./google-calendar";
import { acquireBrowser, releaseBrowser, resetBrowser, withBrowserLock } from "./browser";
import { createFollowup, logInteraction, resolveFollowup, updatePerson } from "@kokoro/kizuna";
import {
  createRoutine,
  createSkill,
  getRoutineById,
  getSkillById,
  updateRoutineIfVersion,
  updateSkillIfVersion,
  applyRoutineRefinement,
  isDuplicateKeyError,
  recordProposalDecision,
  recordSkillProposalDecision,
} from "@kokoro/db";
import {
  createFollowupInputSchema,
  logInteractionInputSchema,
  resolveFollowupInputSchema,
  updatePersonInputSchema,
} from "../ai/tools/crm";
import { parameterSchema } from "../ai/tools/routine-schema";
import { ROUTINE_PROPOSAL_TOOLS } from "../ai/tools/routine-proposal-tools";
import { SKILL_PROPOSAL_TOOLS } from "../ai/tools/skill-proposal-tools";
import { config, logger, runWithSpan } from "@kokoro/shared";
import type { IPendingConfirmation } from "@kokoro/db";

/**
 * Tools that the LLM must wrap in a `requestConfirmation` call rather than
 * invoking directly. This is the enum `requestConfirmation` exposes, so it is
 * exactly the set of actions the model may *raise* a confirmation for.
 *
 * Adding a new gated tool requires three things:
 *   1. add its name here (single source of truth)
 *   2. add a Zod schema entry in `GATED_ARG_SCHEMAS`
 *   3. add a case in `dispatchGatedAction`
 */
export const GATED_TOOL_NAMES = [
  "sendEmail",
  "manageCalendar",
  "browseAgent",
  "logInteraction",
  "createFollowup",
  "resolveFollowup",
  "updatePerson",
] as const;
type GatedToolName = (typeof GATED_TOOL_NAMES)[number];

/**
 * Dispatch-only actions: executable through the approval rail but deliberately
 * NOT in `GATED_TOOL_NAMES`, so they're absent from `requestConfirmation`'s
 * enum. `createRoutine` is reachable only via `proposeRoutine`, and
 * `updateRoutinePrompt` only via `proposeRoutineRefinement` → the approval
 * bubble, which runs the durable anti-nag guard first; exposing either on
 * `requestConfirmation` would let the model self-author or self-edit a routine
 * while bypassing that guard. `disableRoutine` (routine retirement) is reachable
 * only via the self-review pass's `proposeRetirement`. The skill curation
 * actions — `updateSkill`, `disableSkill`, `mergeSkills` — are likewise
 * reachable only via the skill-review pass's proposal cores
 * (`skill-refinements.ts`).
 */
const DISPATCH_ONLY_TOOL_NAMES = [
  "createRoutine",
  "createSkill",
  "updateRoutinePrompt",
  "disableRoutine",
  "updateSkill",
  "disableSkill",
  "mergeSkills",
] as const;
type DispatchOnlyToolName = (typeof DISPATCH_ONLY_TOOL_NAMES)[number];

type DispatchableToolName = GatedToolName | DispatchOnlyToolName;

export function isGatedTool(name: string): name is GatedToolName {
  return (GATED_TOOL_NAMES as readonly string[]).includes(name);
}

function isDispatchable(name: string): name is DispatchableToolName {
  return isGatedTool(name) || (DISPATCH_ONLY_TOOL_NAMES as readonly string[]).includes(name);
}

const sendEmailArgs = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
});

// Mutating calendar actions only. List/create stay un-gated — they're cheap
// and easily reversed. The schema enforces the narrowed action set so the
// LLM can't smuggle a `list` through the wrapper.
const manageCalendarArgs = z.object({
  action: z.enum(["update", "delete"]),
  eventId: z.string().min(1),
  summary: z.string().optional(),
  description: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  location: z.string().optional(),
});

// Browser autonomous agent only. Other browse actions (search/visit/extract/
// act/screenshot/login) stay un-gated. The agent runs up to 25 steps and
// can do real things on real sites — the riskiest browse mode.
const browseAgentArgs = z.object({
  goal: z.string().min(1),
});

// Self-authored routine draft. `signature` (normalized name + prompt hash) is
// threaded through so the dispatcher can mark the proposal accepted in the
// durable decline store. Routines created this way are always read-purity /
// on-demand (no cron) — those safe defaults are applied at dispatch, NOT taken
// from the draft, so the model can't smuggle a cron'd action routine through.
const createRoutineArgs = z.object({
  signature: z.string().min(1),
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  prompt: z.string().min(1).max(4000),
  parameters: z.array(parameterSchema).optional(),
});

const createSkillArgs = z.object({
  signature: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Skill names must be lowercase alphanumeric with dashes"),
  description: z.string().min(1).max(500),
  body: z.string().min(1).max(6000),
  triggers: z.array(z.string().min(1).max(140)).max(20).optional(),
  tags: z.array(z.string().min(1).max(140)).max(20).optional(),
});

// Self-authored refinement of an existing routine's prompt. `baseVersion` is the
// version the proposal was raised against — the dispatcher rejects the update if
// the routine has since changed, so a stale 2h-old bubble can't clobber a newer
// edit. Like `createRoutineArgs`, this schema deliberately omits `purity`,
// `cronSchedule`, `reportMode`, and `enabled`: a refinement rewrites WHAT a
// routine does, never escalates it to action-purity or bolts on a schedule.
const updateRoutinePromptArgs = z.object({
  signature: z.string().min(1),
  routineId: z.string().min(1),
  baseVersion: z.number().int().nonnegative(),
  newPrompt: z.string().min(1).max(4000),
  newParameters: z.array(parameterSchema).optional(),
  // Loop closure: omitted (→ true) for a normal refinement, which arms
  // regression tracking; false for a self-review revert, which clears it.
  trackForRegression: z.boolean().optional(),
});

// Routine retirement (disable, never delete). Same `baseVersion` staleness
// guard as updateRoutinePrompt so a stale proposal can't disable a routine that
// was edited (perhaps fixed) since the bubble was raised.
const disableRoutineArgs = z.object({
  signature: z.string().min(1),
  routineId: z.string().min(1),
  baseVersion: z.number().int().nonnegative(),
});

// Curated rewrite of an existing skill's content. Mirrors updateRoutinePrompt:
// `baseVersion` is CAS'd so a stale 2h-old bubble can't clobber a newer edit,
// and the schema deliberately omits `enabled`, `name`, and `source` — curation
// rewrites WHAT a skill says, never renames its stable handle or re-enables it.
const updateSkillArgs = z
  .object({
    signature: z.string().min(1),
    skillId: z.string().min(1),
    baseVersion: z.number().int().nonnegative(),
    newDescription: z.string().min(1).max(500).optional(),
    newBody: z.string().min(1).max(6000).optional(),
    newTriggers: z.array(z.string().min(1).max(140)).max(20).optional(),
    newTags: z.array(z.string().min(1).max(140)).max(20).optional(),
  })
  .refine(
    (a) =>
      a.newDescription !== undefined ||
      a.newBody !== undefined ||
      a.newTriggers !== undefined ||
      a.newTags !== undefined,
    { message: "at least one content field must be provided" },
  );

// Skill archive (disable, never delete — Hermes-style: archived skills stay
// re-enableable from the dashboard). Same `baseVersion` staleness guard as
// disableRoutine.
const disableSkillArgs = z.object({
  signature: z.string().min(1),
  skillId: z.string().min(1),
  baseVersion: z.number().int().nonnegative(),
});

// Skill merge: the survivor (`skillId`) takes the merged content, and the
// absorbed skills are archived in the same approved action — one bubble, one
// tap, one decision. Every participant carries the version its content was
// merged from, so any raced edit is rejected rather than silently folded over.
const mergeSkillsArgs = z
  .object({
    signature: z.string().min(1),
    skillId: z.string().min(1),
    baseVersion: z.number().int().nonnegative(),
    absorbed: z
      .array(
        z.object({
          skillId: z.string().min(1),
          baseVersion: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(5),
    newBody: z.string().min(1).max(6000),
    newDescription: z.string().min(1).max(500).optional(),
    newTriggers: z.array(z.string().min(1).max(140)).max(20).optional(),
    newTags: z.array(z.string().min(1).max(140)).max(20).optional(),
  })
  .refine((a) => !a.absorbed.some((s) => s.skillId === a.skillId), {
    message: "a skill cannot absorb itself",
  });

// CRM-write schemas are imported from `apps/bot/src/ai/tools/crm.ts` so the
// dispatcher's re-validator and the tool's `inputSchema` are guaranteed to
// stay in sync (Kizuna's API does not enforce the LLM-facing caps, so the
// dispatcher schema is the only stop between the LLM and the database).
const GATED_ARG_SCHEMAS: Record<DispatchableToolName, z.ZodTypeAny> = {
  sendEmail: sendEmailArgs,
  manageCalendar: manageCalendarArgs,
  browseAgent: browseAgentArgs,
  logInteraction: logInteractionInputSchema,
  createFollowup: createFollowupInputSchema,
  resolveFollowup: resolveFollowupInputSchema,
  updatePerson: updatePersonInputSchema,
  createRoutine: createRoutineArgs,
  createSkill: createSkillArgs,
  updateRoutinePrompt: updateRoutinePromptArgs,
  disableRoutine: disableRoutineArgs,
  updateSkill: updateSkillArgs,
  disableSkill: disableSkillArgs,
  mergeSkills: mergeSkillsArgs,
};

interface DispatchResult {
  success: boolean;
  /** Short human-readable line shown back to the user in the edited prompt. */
  summary: string;
  /** Full structured result for logging / conversation injection. */
  detail: Record<string, unknown>;
}

interface DispatchContext {
  /** Chat the confirmation belongs to. Required by chat-scoped actions
   * (`createRoutine`); ignored by the global Google/CRM actions. Sourced from
   * the resolved `PendingConfirmation` row, never from LLM-supplied args. */
  chatId?: string;
}

export async function dispatchGatedAction(
  tool: string,
  rawArgs: unknown,
  ctx: DispatchContext = {},
): Promise<DispatchResult> {
  if (!isDispatchable(tool)) {
    return {
      success: false,
      summary: `unknown gated tool "${tool}"`,
      detail: { reason: "unknown_tool", tool },
    };
  }

  const schema = GATED_ARG_SCHEMAS[tool];
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      success: false,
      summary: "invalid arguments",
      detail: { reason: "invalid_args", issues: parsed.error.issues },
    };
  }

  try {
    switch (tool) {
      case "sendEmail": {
        const args = parsed.data as z.infer<typeof sendEmailArgs>;
        logger.info({ to: args.to, subject: args.subject }, "Dispatching approved sendEmail");
        const options =
          args.threadId || args.inReplyTo
            ? { threadId: args.threadId, inReplyTo: args.inReplyTo }
            : undefined;
        const result = await sendEmail(args.to, args.subject, args.body, options);
        return {
          success: true,
          summary: `email sent to ${args.to}`,
          detail: { id: result.id, threadId: result.threadId },
        };
      }

      case "manageCalendar": {
        const args = parsed.data as z.infer<typeof manageCalendarArgs>;
        logger.info(
          { action: args.action, eventId: args.eventId },
          "Dispatching approved manageCalendar",
        );
        if (args.action === "delete") {
          await deleteEvent(args.eventId);
          return {
            success: true,
            summary: `calendar event ${args.eventId} deleted`,
            detail: { eventId: args.eventId },
          };
        }
        const updated = await updateEvent(args.eventId, {
          summary: args.summary,
          description: args.description,
          start: args.start,
          end: args.end,
          location: args.location,
        });
        return {
          success: true,
          summary: `calendar event updated`,
          detail: { event: updated },
        };
      }

      case "browseAgent": {
        const args = parsed.data as z.infer<typeof browseAgentArgs>;
        logger.info({ goal: args.goal.slice(0, 80) }, "Dispatching approved browseAgent");
        return await withBrowserLock(
          async () => {
            let acquired = false;
            let resetDone = false;
            try {
              const stagehand = await acquireBrowser();
              acquired = true;
              const text = await runWithSpan("browse.agent", async () => {
                const agent = stagehand.agent();
                const result = await agent.execute({ instruction: args.goal, maxSteps: 25 });
                return typeof result === "string" ? result : JSON.stringify(result);
              });
              return {
                success: true,
                summary: `agent finished: ${text.slice(0, 200)}`,
                detail: { result: text.slice(0, 4000) },
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : "browser agent failed";
              if (
                message.includes("Target closed") ||
                message.includes("Browser closed") ||
                message.includes("timed out")
              ) {
                resetBrowser();
                resetDone = true;
              }
              throw error;
            } finally {
              // releaseBrowser arms the 5-minute idle-shutdown timer. Only
              // call it when we actually have a live instance to release —
              // otherwise we'd schedule a shutdown that resets `lockChain`
              // for nothing, potentially orphaning queued callers. Skip
              // also when resetBrowser already tore the singleton down.
              if (acquired && !resetDone) {
                releaseBrowser();
              }
            }
          },
          // Autonomous 25-step runs can legitimately take many minutes;
          // override the default 2-min circuit breaker.
          { timeoutMs: 10 * 60 * 1000, label: "browseAgent" },
        );
      }

      case "logInteraction": {
        const args = parsed.data as z.infer<typeof logInteractionInputSchema>;
        logger.info(
          { channel: args.channel, participants: args.participants.length },
          "Dispatching approved logInteraction",
        );
        const interaction = await logInteraction(args);
        return {
          success: true,
          summary: `interaction logged: ${args.title}`,
          detail: { interaction },
        };
      }

      case "createFollowup": {
        const args = parsed.data as z.infer<typeof createFollowupInputSchema>;
        logger.info(
          { direction: args.direction, hasDue: Boolean(args.dueAt) },
          "Dispatching approved createFollowup",
        );
        const followup = await createFollowup(args);
        return {
          success: true,
          summary: `followup created for ${followup.person.displayName}`,
          detail: { followup },
        };
      }

      case "resolveFollowup": {
        const args = parsed.data as z.infer<typeof resolveFollowupInputSchema>;
        logger.info({ status: args.status }, "Dispatching approved resolveFollowup");
        const followup = await resolveFollowup(args);
        return {
          success: true,
          summary: `followup ${args.status}`,
          detail: { followup },
        };
      }

      case "updatePerson": {
        const args = parsed.data as z.infer<typeof updatePersonInputSchema>;
        logger.info(
          { fields: Object.keys(args).filter((k) => k !== "personId") },
          "Dispatching approved updatePerson",
        );
        const person = await updatePerson(args);
        return {
          success: true,
          summary: `updated ${person.displayName}`,
          detail: { person },
        };
      }

      case "createRoutine": {
        const args = parsed.data as z.infer<typeof createRoutineArgs>;
        if (!ctx.chatId) {
          return {
            success: false,
            summary: "cannot save routine — missing chat context",
            detail: { reason: "no_chat_context" },
          };
        }
        // No cron-validation needed: createRoutineArgs has no cronSchedule field,
        // so a proposed routine can never carry a schedule (safe defaults below
        // hardcode `cronSchedule: null`). The schema is the authoritative gate.

        logger.info({ chatId: ctx.chatId, name: args.name }, "Dispatching approved createRoutine");

        let routineId: string | null = null;
        try {
          const routine = await createRoutine(ctx.chatId, {
            name: args.name,
            description: args.description,
            prompt: args.prompt,
            parameters: args.parameters ?? [],
            // Safe defaults — self-authored routines are read-only and
            // on-demand. They never run autonomously; upgrading to action/cron
            // stays the explicit, user-driven manageRoutines path.
            cronSchedule: null,
            reportMode: "always",
            purity: "read",
            nextRunAt: null,
            enabled: true,
          });
          routineId = String(routine._id);
        } catch (error) {
          // A routine with this name already exists — treat as a graceful
          // no-op (we still record the accept below so we stop offering it).
          if (!isDuplicateKeyError(error)) throw error;
        }

        // Record the accept once, regardless of created-vs-duplicate, so the
        // model doesn't re-propose. Best-effort — a write blip here must not
        // fail the save.
        await recordProposalDecision(ctx.chatId, args.signature, "accepted", {
          cooldownDays: config.ROUTINE_PROPOSAL_COOLDOWN_DAYS,
        }).catch(() => {});

        return routineId
          ? {
              success: true,
              summary: `routine "${args.name}" saved (on-demand)`,
              detail: { routineId },
            }
          : {
              success: false,
              summary: `a routine named "${args.name}" already exists`,
              detail: { reason: "duplicate_name" },
            };
      }

      case "createSkill": {
        const args = parsed.data as z.infer<typeof createSkillArgs>;
        if (!ctx.chatId) {
          return {
            success: false,
            summary: "cannot save skill — missing chat context",
            detail: { reason: "no_chat_context" },
          };
        }

        logger.info({ chatId: ctx.chatId, name: args.name }, "Dispatching approved createSkill");

        let skillId: string | null = null;
        try {
          const skill = await createSkill(ctx.chatId, {
            name: args.name,
            description: args.description,
            body: args.body,
            triggers: args.triggers ?? [],
            tags: args.tags ?? [],
            enabled: true,
            source: "distilled",
          });
          skillId = String(skill._id);
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
        }

        await recordSkillProposalDecision(ctx.chatId, args.signature, "accepted", {
          cooldownDays: config.ROUTINE_PROPOSAL_COOLDOWN_DAYS,
        }).catch(() => {});

        return skillId
          ? {
              success: true,
              summary: `skill "${args.name}" saved`,
              detail: { skillId },
            }
          : {
              success: false,
              summary: `a skill named "${args.name}" already exists`,
              detail: { reason: "duplicate_name" },
            };
      }

      case "updateRoutinePrompt": {
        const args = parsed.data as z.infer<typeof updateRoutinePromptArgs>;
        if (!ctx.chatId) {
          return {
            success: false,
            summary: "cannot update routine — missing chat context",
            detail: { reason: "no_chat_context" },
          };
        }

        logger.info(
          { chatId: ctx.chatId, routineId: args.routineId, baseVersion: args.baseVersion },
          "Dispatching approved updateRoutinePrompt",
        );

        // Atomic compare-and-set on version: the write only lands if the routine
        // is still at the version the proposal was raised against, so a
        // concurrent edit (dashboard / self-review / another bubble) in the ≤2h
        // the bubble sat is rejected, not clobbered. Only prompt (and optionally
        // parameters) change — purity/cronSchedule/reportMode/enabled are absent
        // from the schema, so a refinement can never escalate a read routine to
        // action or add a schedule. No `accepted` decision is recorded: the
        // prompt now equals the approved one (the proposeRefinement equality
        // guard blocks an identical re-proposal) and a genuinely different future
        // fix should be allowed — a version-scoped accept could never match it
        // anyway (version just bumped). `applyRoutineRefinement` also snapshots
        // the pre-edit prompt + grade for loop-closure unless this is a revert
        // (trackForRegression:false), in which case it clears that tracking.
        const updated = await applyRoutineRefinement(
          args.routineId,
          ctx.chatId,
          args.baseVersion,
          {
            prompt: args.newPrompt,
            ...(args.newParameters !== undefined ? { parameters: args.newParameters } : {}),
          },
          { trackForRegression: args.trackForRegression !== false },
        );
        if (updated) {
          return {
            success: true,
            summary: `routine "${updated.name}" updated (v${updated.version})`,
            detail: { routineId: args.routineId, version: updated.version },
          };
        }
        // Didn't update — disambiguate gone-vs-raced.
        const current = await getRoutineById(args.routineId, ctx.chatId);
        return current
          ? {
              success: false,
              summary: `routine "${current.name}" changed since this was proposed — re-evaluate`,
              detail: {
                reason: "version_conflict",
                expected: args.baseVersion,
                actual: current.version,
              },
            }
          : {
              success: false,
              summary: "routine not found",
              detail: { reason: "not_found", routineId: args.routineId },
            };
      }

      case "disableRoutine": {
        const args = parsed.data as z.infer<typeof disableRoutineArgs>;
        if (!ctx.chatId) {
          return {
            success: false,
            summary: "cannot disable routine — missing chat context",
            detail: { reason: "no_chat_context" },
          };
        }

        logger.info(
          { chatId: ctx.chatId, routineId: args.routineId, baseVersion: args.baseVersion },
          "Dispatching approved disableRoutine",
        );

        // Atomic version-guarded disable (reversible via manageRoutines enable /
        // the dashboard), never delete — deleting would also wipe RoutineLog
        // history. No `accepted` decision is recorded: a disabled routine is
        // excluded from health/review anyway, and on re-enable we WANT it
        // reviewable again — a durable accept would suppress re-proposing
        // retirement for ~90 days even after the user re-enables it.
        const disabled = await updateRoutineIfVersion(
          args.routineId,
          ctx.chatId,
          args.baseVersion,
          {
            enabled: false,
          },
        );
        if (disabled) {
          return {
            success: true,
            summary: `routine "${disabled.name}" disabled`,
            detail: { routineId: args.routineId },
          };
        }
        const current = await getRoutineById(args.routineId, ctx.chatId);
        return current
          ? {
              success: false,
              summary: `routine "${current.name}" changed since this was proposed — re-evaluate`,
              detail: {
                reason: "version_conflict",
                expected: args.baseVersion,
                actual: current.version,
              },
            }
          : {
              success: false,
              summary: "routine not found",
              detail: { reason: "not_found", routineId: args.routineId },
            };
      }

      case "updateSkill": {
        const args = parsed.data as z.infer<typeof updateSkillArgs>;
        if (!ctx.chatId) {
          return {
            success: false,
            summary: "cannot update skill — missing chat context",
            detail: { reason: "no_chat_context" },
          };
        }

        logger.info(
          { chatId: ctx.chatId, skillId: args.skillId, baseVersion: args.baseVersion },
          "Dispatching approved updateSkill",
        );

        // Atomic compare-and-set on version, same shape as updateRoutinePrompt:
        // the write lands only if the skill is still at the version the proposal
        // was raised against. No `accepted` decision is recorded — the signature
        // is version-scoped, and the version just bumped, so it could never
        // match a future proposal anyway.
        const updated = await updateSkillIfVersion(args.skillId, ctx.chatId, args.baseVersion, {
          ...(args.newDescription !== undefined ? { description: args.newDescription } : {}),
          ...(args.newBody !== undefined ? { body: args.newBody } : {}),
          ...(args.newTriggers !== undefined ? { triggers: args.newTriggers } : {}),
          ...(args.newTags !== undefined ? { tags: args.newTags } : {}),
        });
        if (updated) {
          return {
            success: true,
            summary: `skill "${updated.name}" updated (v${updated.version})`,
            detail: { skillId: args.skillId, version: updated.version },
          };
        }
        // Didn't update — disambiguate gone vs raced vs archived. The CAS also
        // requires `enabled` (a dashboard archive doesn't bump version), so a
        // version match here means the user archived the skill while the
        // bubble sat — don't rewrite a skill they just put away.
        const current = await getSkillById(args.skillId, ctx.chatId);
        if (!current) {
          return {
            success: false,
            summary: "skill not found",
            detail: { reason: "not_found", skillId: args.skillId },
          };
        }
        if (current.version !== args.baseVersion) {
          return {
            success: false,
            summary: `skill "${current.name}" changed since this was proposed — re-evaluate`,
            detail: {
              reason: "version_conflict",
              expected: args.baseVersion,
              actual: current.version,
            },
          };
        }
        return {
          success: false,
          summary: `skill "${current.name}" was archived after this was proposed — leaving it untouched`,
          detail: { reason: "state_conflict", skillId: args.skillId },
        };
      }

      case "disableSkill": {
        const args = parsed.data as z.infer<typeof disableSkillArgs>;
        if (!ctx.chatId) {
          return {
            success: false,
            summary: "cannot archive skill — missing chat context",
            detail: { reason: "no_chat_context" },
          };
        }

        logger.info(
          { chatId: ctx.chatId, skillId: args.skillId, baseVersion: args.baseVersion },
          "Dispatching approved disableSkill",
        );

        // Archive = version-guarded disable (re-enableable from the dashboard),
        // never delete. Same no-accept reasoning as disableRoutine: on re-enable
        // we WANT the skill reviewable again — a durable accept would suppress
        // re-proposing the archive long after the user un-archived it.
        const disabled = await updateSkillIfVersion(args.skillId, ctx.chatId, args.baseVersion, {
          enabled: false,
        });
        if (disabled) {
          return {
            success: true,
            summary: `skill "${disabled.name}" archived`,
            detail: { skillId: args.skillId },
          };
        }
        const current = await getSkillById(args.skillId, ctx.chatId);
        if (!current) {
          return {
            success: false,
            summary: "skill not found",
            detail: { reason: "not_found", skillId: args.skillId },
          };
        }
        if (current.version !== args.baseVersion) {
          return {
            success: false,
            summary: `skill "${current.name}" changed since this was proposed — re-evaluate`,
            detail: {
              reason: "version_conflict",
              expected: args.baseVersion,
              actual: current.version,
            },
          };
        }
        // Version matches but the CAS refused → the skill is already disabled
        // (dashboard archive while the bubble sat — toggles don't bump
        // version). The approved end-state already holds; report it as done.
        return {
          success: true,
          summary: `skill "${current.name}" was already archived`,
          detail: { skillId: args.skillId, alreadyArchived: true },
        };
      }

      case "mergeSkills": {
        const args = parsed.data as z.infer<typeof mergeSkillsArgs>;
        if (!ctx.chatId) {
          return {
            success: false,
            summary: "cannot merge skills — missing chat context",
            detail: { reason: "no_chat_context" },
          };
        }

        logger.info(
          {
            chatId: ctx.chatId,
            skillId: args.skillId,
            baseVersion: args.baseVersion,
            absorbedCount: args.absorbed.length,
          },
          "Dispatching approved mergeSkills",
        );

        // Preflight every absorbee BEFORE touching the survivor: the survivor
        // write is the point of no return (its body is overwritten with the
        // merged content), so a stale absorbee must cancel the whole merge
        // while nothing has changed yet. Acceptable states: still at
        // baseVersion and enabled (will be CAS-archived below), or already
        // disabled at baseVersion (dashboard archive — the goal state holds
        // and its content at that version is exactly what was folded in).
        const staleAbsorbed: { skillId: string; reason: string }[] = [];
        for (const a of args.absorbed) {
          const current = await getSkillById(a.skillId, ctx.chatId);
          if (!current) {
            staleAbsorbed.push({ skillId: a.skillId, reason: "not_found" });
          } else if (current.version !== a.baseVersion) {
            staleAbsorbed.push({ skillId: a.skillId, reason: "version_conflict" });
          }
        }
        if (staleAbsorbed.length > 0) {
          logger.warn(
            { chatId: ctx.chatId, skillId: args.skillId, failed: staleAbsorbed },
            "mergeSkills preflight found stale absorbed skills — merge cancelled",
          );
          return {
            success: false,
            summary: `${staleAbsorbed.length} of ${args.absorbed.length} absorbed skill(s) changed (or are gone) since this was proposed — merge cancelled, nothing changed`,
            detail: {
              reason: "version_conflict",
              skillId: args.skillId,
              failed: staleAbsorbed,
            },
          };
        }

        // Survivor-first ordering: the merged content must land before anything
        // is archived. If the survivor CAS fails (raced edit / gone), abort with
        // NOTHING changed — never archive skills whose content didn't actually
        // get folded into the survivor.
        const survivor = await updateSkillIfVersion(args.skillId, ctx.chatId, args.baseVersion, {
          body: args.newBody,
          ...(args.newDescription !== undefined ? { description: args.newDescription } : {}),
          ...(args.newTriggers !== undefined ? { triggers: args.newTriggers } : {}),
          ...(args.newTags !== undefined ? { tags: args.newTags } : {}),
        });
        if (!survivor) {
          const current = await getSkillById(args.skillId, ctx.chatId);
          if (!current) {
            return {
              success: false,
              summary: "skill not found",
              detail: { reason: "not_found", skillId: args.skillId },
            };
          }
          if (current.version !== args.baseVersion) {
            return {
              success: false,
              summary: `skill "${current.name}" changed since this was proposed — re-evaluate`,
              detail: {
                reason: "version_conflict",
                expected: args.baseVersion,
                actual: current.version,
              },
            };
          }
          // Version matches but the CAS refused → the survivor was archived
          // from the dashboard while the bubble sat (toggles don't bump
          // version). Merging into a skill the user just put away is wrong —
          // abort with nothing changed.
          return {
            success: false,
            summary: `skill "${current.name}" was archived after this was proposed — merge cancelled`,
            detail: { reason: "state_conflict", skillId: args.skillId },
          };
        }

        // Each absorbed archive is its own CAS — the preflight above makes a
        // conflict here a ms-wide race (an edit landing between preflight and
        // archive), but read-then-write can't close that window without
        // transactions (standalone Mongo), so the CAS stays as the backstop.
        // One raced absorbee must not block the others; a partial outcome is
        // surfaced as a failure so the user (and the next review pass) knows
        // duplicates may remain.
        const archived: string[] = [];
        const failed: { skillId: string; reason: string }[] = [];
        for (const a of args.absorbed) {
          const disabled = await updateSkillIfVersion(a.skillId, ctx.chatId, a.baseVersion, {
            enabled: false,
          });
          if (disabled) {
            archived.push(disabled.name);
            continue;
          }
          const current = await getSkillById(a.skillId, ctx.chatId);
          // Already archived at the merged-from version (dashboard toggle — no
          // version bump): the goal state for an absorbee already holds, and
          // its content at that version is exactly what was folded into the
          // survivor. Count it archived rather than failing the merge.
          if (current && !current.enabled && current.version === a.baseVersion) {
            archived.push(current.name);
            continue;
          }
          failed.push({ skillId: a.skillId, reason: current ? "version_conflict" : "not_found" });
        }

        if (failed.length > 0) {
          logger.warn(
            { chatId: ctx.chatId, skillId: args.skillId, failed },
            "mergeSkills archived only part of the absorbed set",
          );
          return {
            success: false,
            summary: `merged into "${survivor.name}", but ${failed.length} of ${args.absorbed.length} absorbed skill(s) changed (or are gone) since this was proposed and were not archived — re-evaluate`,
            detail: {
              reason: "partial_merge",
              skillId: args.skillId,
              version: survivor.version,
              archived,
              failed,
            },
          };
        }
        return {
          success: true,
          summary: `skills merged into "${survivor.name}" (v${survivor.version}) — archived ${archived
            .map((n) => `"${n}"`)
            .join(", ")}`,
          detail: { skillId: args.skillId, version: survivor.version, archived },
        };
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    logger.error({ error: error, tool }, "Gated action dispatch failed");
    return {
      success: false,
      summary: `failed: ${reason}`,
      detail: { reason },
    };
  }
}

/**
 * When a routine proposal confirmation — a `createRoutine` save, an
 * `updateRoutinePrompt` refinement, or a `disableRoutine` retirement — is denied
 * or cancelled, record the decline in the durable store so the model honors the
 * "no" past the 40-message context window / 1h session reset. Discriminates on
 * the action tool (NOT origin) so a routine-raised gated action — e.g. a running
 * routine asking to send an email — never trips this. No-op for every other
 * action; best-effort so a store blip never wedges the deny/cancel path.
 */
export async function recordProposalDeclineFromConfirmation(
  row: Pick<IPendingConfirmation, "chatId" | "action">,
): Promise<void> {
  const signature = row.action.args.signature;
  if (typeof signature !== "string" || signature.length === 0) return;

  if (SKILL_PROPOSAL_TOOLS.has(row.action.tool)) {
    try {
      await recordSkillProposalDecision(row.chatId, signature, "declined", {
        cooldownDays: config.ROUTINE_PROPOSAL_COOLDOWN_DAYS,
      });
    } catch (error) {
      logger.warn({ error, chatId: row.chatId }, "Failed to record skill-proposal decline");
    }
    return;
  }

  if (!ROUTINE_PROPOSAL_TOOLS.has(row.action.tool)) return;
  try {
    await recordProposalDecision(row.chatId, signature, "declined", {
      cooldownDays: config.ROUTINE_PROPOSAL_COOLDOWN_DAYS,
    });
  } catch (error) {
    logger.warn({ error, chatId: row.chatId }, "Failed to record routine-proposal decline");
  }
}
