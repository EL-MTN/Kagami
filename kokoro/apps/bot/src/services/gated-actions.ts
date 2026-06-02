import { z } from "zod";
import { sendEmail } from "./gmail";
import { updateEvent, deleteEvent } from "./google-calendar";
import { acquireBrowser, releaseBrowser, resetBrowser, withBrowserLock } from "./browser";
import { createFollowup, logInteraction, resolveFollowup, updatePerson } from "@kokoro/kizuna";
import { createRoutine, isDuplicateKeyError, recordProposalDecision } from "@kokoro/db";
import {
  createFollowupInputSchema,
  logInteractionInputSchema,
  resolveFollowupInputSchema,
  updatePersonInputSchema,
} from "../ai/tools/crm";
import { parameterSchema } from "../ai/tools/routine-schema";
import { config, logger, runWithSpan, validateCronAndDefaults } from "@kokoro/shared";
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
 * enum. `createRoutine` is reachable only via `proposeRoutine` → the approval
 * bubble, which runs the durable anti-nag guard first; exposing it on
 * `requestConfirmation` would let the model self-author a routine while
 * bypassing that guard.
 */
const DISPATCH_ONLY_TOOL_NAMES = ["createRoutine"] as const;
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
};

interface DispatchResult {
  success: boolean;
  /** Short human-readable line shown back to the user in the edited prompt. */
  summary: string;
  /** Full structured result for logging / conversation injection. */
  detail: Record<string, unknown>;
}

export interface DispatchContext {
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

        // Belt-and-suspenders: proposed routines carry no cron, so this is a
        // no-op today, but it keeps the param/cron invariant enforced at the
        // authoritative gate if a future caller ever passes a schedule.
        const cronError = validateCronAndDefaults(null, args.parameters ?? []);
        if (cronError) {
          return { success: false, summary: cronError.message, detail: { reason: "invalid_args" } };
        }

        logger.info({ chatId: ctx.chatId, name: args.name }, "Dispatching approved createRoutine");

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
          // Best-effort: remember the accept so the model doesn't re-propose
          // the same task. A write blip here must not fail the save itself.
          await recordProposalDecision(ctx.chatId, args.signature, "accepted", {
            cooldownDays: config.ROUTINE_PROPOSAL_COOLDOWN_DAYS,
          }).catch(() => {});
          return {
            success: true,
            summary: `routine "${args.name}" saved (on-demand)`,
            detail: { routineId: String(routine._id) },
          };
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            // A routine with this name already exists — treat as a graceful
            // no-op (still record the accept so we stop offering it).
            await recordProposalDecision(ctx.chatId, args.signature, "accepted", {
              cooldownDays: config.ROUTINE_PROPOSAL_COOLDOWN_DAYS,
            }).catch(() => {});
            return {
              success: false,
              summary: `a routine named "${args.name}" already exists`,
              detail: { reason: "duplicate_name" },
            };
          }
          throw error;
        }
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
 * When a `createRoutine` proposal confirmation is denied or cancelled, record
 * the decline in the durable store so the model honors the "no" past the
 * 40-message context window / 1h session reset. Discriminates on the action
 * tool (NOT origin) so a routine-raised gated action — e.g. a running routine
 * asking to send an email — never trips this. No-op for every other action;
 * best-effort so a store blip never wedges the deny/cancel path.
 */
export async function recordProposalDeclineFromConfirmation(
  row: Pick<IPendingConfirmation, "chatId" | "action">,
): Promise<void> {
  if (row.action.tool !== "createRoutine") return;
  const signature = row.action.args.signature;
  if (typeof signature !== "string" || signature.length === 0) return;
  try {
    await recordProposalDecision(row.chatId, signature, "declined", {
      cooldownDays: config.ROUTINE_PROPOSAL_COOLDOWN_DAYS,
    });
  } catch (error) {
    logger.warn({ error, chatId: row.chatId }, "Failed to record routine-proposal decline");
  }
}
