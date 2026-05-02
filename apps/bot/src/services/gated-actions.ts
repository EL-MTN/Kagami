import { z } from "zod";
import { sendEmail } from "./gmail";
import { updateEvent, deleteEvent } from "./google-calendar";
import { acquireBrowser, releaseBrowser, resetBrowser, withBrowserLock } from "./browser";
import { logger } from "@mashiro/shared";

/**
 * Tools that the LLM must wrap in a `requestConfirmation` call rather than
 * invoking directly. The dispatcher below knows how to execute each one
 * after the user approves the pending confirmation.
 *
 * Adding a new gated tool requires three things:
 *   1. add its name here (single source of truth)
 *   2. add a Zod schema entry in `GATED_ARG_SCHEMAS`
 *   3. add a case in `dispatchGatedAction`
 */
export const GATED_TOOL_NAMES = ["sendEmail", "manageCalendar", "browseAgent"] as const;
export type GatedToolName = (typeof GATED_TOOL_NAMES)[number];

export function isGatedTool(name: string): name is GatedToolName {
  return (GATED_TOOL_NAMES as readonly string[]).includes(name);
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

const GATED_ARG_SCHEMAS: Record<GatedToolName, z.ZodTypeAny> = {
  sendEmail: sendEmailArgs,
  manageCalendar: manageCalendarArgs,
  browseAgent: browseAgentArgs,
};

export interface DispatchResult {
  success: boolean;
  /** Short human-readable line shown back to the user in the edited prompt. */
  summary: string;
  /** Full structured result for logging / conversation injection. */
  detail: Record<string, unknown>;
}

export async function dispatchGatedAction(tool: string, rawArgs: unknown): Promise<DispatchResult> {
  if (!isGatedTool(tool)) {
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
              const agent = stagehand.agent();
              const result = await agent.execute({ instruction: args.goal, maxSteps: 25 });
              const text = typeof result === "string" ? result : JSON.stringify(result);
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
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    logger.error({ error, tool }, "Gated action dispatch failed");
    return {
      success: false,
      summary: `failed: ${reason}`,
      detail: { reason },
    };
  }
}
