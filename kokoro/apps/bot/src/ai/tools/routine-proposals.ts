import { createHash } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { isRecentlyDeclined, listPendingConfirmations } from "@kokoro/db";
import { logger } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { parameterSchema } from "./routine-schema";
import { raisePendingConfirmation } from "./confirmations";
import { hasPendingRoutineProposal } from "./routine-proposal-tools";

// Proposals expire faster than action confirmations (24h): an ignored "want me
// to save this?" bubble shouldn't linger for a day. Two hours is long enough
// for the user to tap, short enough that a stale offer clears on its own.
// Exported so the self-review proposals (routine-refinements) share one TTL.
export const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Stable signature for a proposed routine: normalized name + a short hash of
 * the prompt. Keys the durable decline store so re-offering the *same* routine
 * is suppressed, while a genuinely different task still gets through. Intent-
 * level dedup (embeddings) is a future enhancement; this is the v1 heuristic.
 */
export function computeProposalSignature(name: string, prompt: string): string {
  const normName = name.trim().toLowerCase().replace(/\s+/g, " ");
  const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 8);
  return `${normName}#${promptHash}`;
}

/**
 * Render the approval bubble for a routine proposal. Shows the FULL routine
 * prompt (not a one-line summary) plus its parameters, labeled on-demand /
 * read-only, so the user reviews exactly what they're approving.
 */
function buildProposalPrompt(draft: {
  name: string;
  description: string;
  prompt: string;
  parameters: z.infer<typeof parameterSchema>[];
}): string {
  const lines = [
    `Save this as a reusable routine? (on-demand, read-only)`,
    ``,
    `**${draft.name}** — ${draft.description}`,
    ``,
    draft.prompt,
  ];
  if (draft.parameters.length > 0) {
    lines.push(``, `Parameters:`);
    for (const p of draft.parameters) {
      lines.push(`• ${p.name} (${p.type}${p.required ? ", required" : ""}) — ${p.description}`);
    }
  }
  return lines.join("\n");
}

/**
 * Model-facing (ungated) tool that lets Mashiro offer to save a just-completed
 * multi-step task as a reusable routine. It does NOT create anything directly:
 * it runs the durable anti-nag guard, then raises a tap-to-approve bubble whose
 * approved action is the dispatch-only `createRoutine`. The routine is created
 * only after the user taps Approve.
 */
export function createProposeRoutineTool(chatId: string, adapter: PlatformAdapter) {
  return tool({
    description:
      "Offer to save a just-finished, repeatable multi-step task as a reusable on-demand routine. Only call this on a natural closing turn (never mid-task), at most one at a time, and only for genuinely reusable procedures — not trivial or one-off requests. Generalize the concrete run into a reusable prompt, with parameters for the parts that varied. Goshujin-sama gets a tap-to-approve bubble; the routine is created only if he approves. Returns immediately — don't call it again in the same turn.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Short unique routine name (used as its identifier), e.g. 'morning-news-digest'.",
        ),
      description: z
        .string()
        .min(1)
        .max(500)
        .describe("One line on what the routine does — shown when listing routines."),
      prompt: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          "Generalized execution instructions that run as an LLM call. Reference parameters by name; don't hardcode the values that varied this run.",
        ),
      parameters: z
        .array(parameterSchema)
        .optional()
        .describe("Typed parameters for the parts that vary between runs."),
    }),
    execute: async ({ name, description, prompt, parameters }) => {
      try {
        const params = parameters ?? [];
        const signature = computeProposalSignature(name, prompt);

        // Both guards are independent reads — run them concurrently.
        // GUARD 1 — durable decline memory: honors a prior "no" past the
        //   40-message window / 1h session reset the LLM can't see.
        // GUARD 2 — one routine proposal at a time, across ALL proposal types
        //   (save/refine/retire): also protects iMessage's "exactly one pending"
        //   YES/NO resolver from stacked bubbles.
        const [declined, pending] = await Promise.all([
          isRecentlyDeclined(chatId, signature),
          listPendingConfirmations(chatId),
        ]);
        if (declined) {
          return { proposed: false, reason: "Goshujin-sama declined a similar routine recently" };
        }
        if (hasPendingRoutineProposal(pending)) {
          return { proposed: false, reason: "a routine proposal is already awaiting approval" };
        }

        const confirmationId = await raisePendingConfirmation(chatId, adapter, {
          summary: `Save routine "${name}"`,
          promptText: buildProposalPrompt({ name, description, prompt, parameters: params }),
          ttlMs: PROPOSAL_TTL_MS,
          origin: "routine",
          action: {
            tool: "createRoutine",
            args: { signature, name, description, prompt, parameters: params },
          },
        });

        logger.debug({ chatId, name, confirmationId }, "Tool: proposeRoutine");
        return {
          proposed: true,
          confirmationId,
          message:
            "Routine-save prompt sent. Stop here — don't call this again this turn. Goshujin-sama will tap Approve or Deny.",
        };
      } catch (error) {
        logger.error({ error, chatId }, "Tool: proposeRoutine failed");
        return {
          proposed: false,
          reason: error instanceof Error ? error.message : "Failed to raise routine proposal",
        };
      }
    },
  });
}
