import { createHash } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { getRoutineById, isRecentlyDeclined, listPendingConfirmations } from "@kokoro/db";
import { logger } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { parameterSchema } from "./routine-schema";
import { raisePendingConfirmation } from "./confirmations";

// A refinement offer expires as fast as a creation proposal — an ignored "want
// me to fix this routine?" bubble shouldn't linger for a day.
const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Stable signature for a proposed refinement: routine id + the version it
 * improves + a short hash of the new prompt. Keys the durable decline store.
 *  - Including `baseVersion` means once an edit lands (version bumps), any prior
 *    decline against the old version stops matching — a routine that drifts
 *    again later still gets a fresh offer.
 *  - Including the new-prompt hash means re-proposing the *same* fix is
 *    suppressed, while a genuinely different fix still gets through.
 */
export function computeRefinementSignature(
  routineId: string,
  baseVersion: number,
  newPrompt: string,
): string {
  const promptHash = createHash("sha256").update(newPrompt).digest("hex").slice(0, 8);
  return `refine:${routineId}#${baseVersion}#${promptHash}`;
}

/**
 * Render the approval bubble for a refinement: the routine name, why it's being
 * changed, and the current → proposed prompt so Goshujin-sama reviews the exact
 * diff before approving. Labeled before/after (not a char-level diff) — clearer
 * to read on Telegram / iMessage.
 */
function buildRefinementPrompt(input: {
  name: string;
  rationale: string;
  oldPrompt: string;
  newPrompt: string;
  paramsChanged: boolean;
}): string {
  const lines = [
    `Update the routine "${input.name}"? (prompt only — its schedule and read/action permission stay the same)`,
    ``,
    `Why: ${input.rationale}`,
    ``,
    `Current:`,
    input.oldPrompt,
    ``,
    `Proposed:`,
    input.newPrompt,
  ];
  if (input.paramsChanged) {
    lines.push(``, `(its parameters would also be updated)`);
  }
  return lines.join("\n");
}

/**
 * Model-facing (ungated) tool that lets Mashiro offer to improve an existing
 * routine's prompt when it has been failing or returning empty results. Like
 * `proposeRoutine`, it creates nothing directly: it runs the durable anti-nag
 * guard, then raises a tap-to-approve bubble whose approved action is the
 * dispatch-only `updateRoutinePrompt`. The prompt changes only after the user
 * taps Approve — and the refinement can never alter the routine's schedule or
 * purity (the dispatcher schema omits those fields).
 */
export function createProposeRoutineRefinementTool(chatId: string, adapter: PlatformAdapter) {
  return tool({
    description:
      "Offer to improve an existing routine's prompt when it has been failing or returning empty results (the Available Routines list flags these). Look the routine up first to get its id and current prompt, then pass a revised `prompt` that fixes the problem plus a one-line `rationale`. Only refine genuinely underperforming routines, on a natural closing turn, at most one at a time. Goshujin-sama gets a tap-to-approve bubble showing the before/after; the routine changes only if he approves. The refinement only touches the prompt (and parameters, if you pass them) — never the schedule or read/action permission. Returns immediately — don't call it again this turn.",
    inputSchema: z.object({
      routineId: z
        .string()
        .min(1)
        .describe("Id of the routine to refine (from searchRoutines / the routine list)."),
      newPrompt: z
        .string()
        .min(1)
        .max(4000)
        .describe("The revised execution prompt that fixes the routine's problem."),
      rationale: z
        .string()
        .min(1)
        .max(300)
        .describe("One line on what was wrong and how this fixes it — shown to Goshujin-sama."),
      newParameters: z
        .array(parameterSchema)
        .optional()
        .describe(
          "Only if the parameter set must change too; omit to keep the routine's existing parameters.",
        ),
    }),
    execute: async ({ routineId, newPrompt, rationale, newParameters }) => {
      try {
        const routine = await getRoutineById(routineId, chatId);
        if (!routine) {
          return { proposed: false, reason: `Routine ${routineId} not found` };
        }
        if (!routine.enabled) {
          return { proposed: false, reason: `Routine "${routine.name}" is disabled` };
        }
        if (newPrompt.trim() === routine.prompt.trim()) {
          return { proposed: false, reason: "the proposed prompt is identical to the current one" };
        }

        const signature = computeRefinementSignature(routineId, routine.version, newPrompt);

        // Both guards are independent reads — run them concurrently.
        // GUARD 1 — durable decline memory: honors a prior "no" past the
        //   40-message window / 1h session reset the LLM can't see.
        // GUARD 2 — one refinement per routine in flight: also protects
        //   iMessage's "exactly one pending" YES/NO resolver from stacked
        //   bubbles.
        const [declined, pending] = await Promise.all([
          isRecentlyDeclined(chatId, signature),
          listPendingConfirmations(chatId),
        ]);
        if (declined) {
          return { proposed: false, reason: "Goshujin-sama declined this refinement recently" };
        }
        if (
          pending.some(
            (p) => p.action.tool === "updateRoutinePrompt" && p.action.args.routineId === routineId,
          )
        ) {
          return {
            proposed: false,
            reason: "a refinement for this routine is already awaiting approval",
          };
        }

        const confirmationId = await raisePendingConfirmation(chatId, adapter, {
          summary: `Update routine "${routine.name}"`,
          promptText: buildRefinementPrompt({
            name: routine.name,
            rationale,
            oldPrompt: routine.prompt,
            newPrompt,
            paramsChanged: newParameters !== undefined,
          }),
          ttlMs: PROPOSAL_TTL_MS,
          origin: "routine",
          action: {
            tool: "updateRoutinePrompt",
            args: {
              signature,
              routineId,
              baseVersion: routine.version,
              newPrompt,
              ...(newParameters !== undefined ? { newParameters } : {}),
            },
          },
        });

        logger.debug({ chatId, routineId, confirmationId }, "Tool: proposeRoutineRefinement");
        return {
          proposed: true,
          confirmationId,
          message:
            "Refinement prompt sent. Stop here — don't call this again this turn. Goshujin-sama will tap Approve or Deny.",
        };
      } catch (error) {
        logger.error({ error, chatId, routineId }, "Tool: proposeRoutineRefinement failed");
        return {
          proposed: false,
          reason: error instanceof Error ? error.message : "Failed to raise routine refinement",
        };
      }
    },
  });
}
