import { createHash } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { getRoutineById, isRecentlyDeclined, listPendingConfirmations } from "@kokoro/db";
import { logger } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import type { IRoutine, IRoutineParameter } from "@kokoro/db";
import { parameterSchema } from "./routine-schema";
import { raisePendingConfirmation } from "./confirmations";
import { hasPendingRoutineProposal } from "./routine-proposal-tools";
// Self-review proposals (refine/retire) expire on the same short window as a
// creation proposal — share the constant so the two can't drift apart.
import { PROPOSAL_TTL_MS } from "./routine-proposals";

type RoutineParameter = z.infer<typeof parameterSchema>;

export interface ProposalResult {
  proposed: boolean;
  confirmationId?: string;
  reason?: string;
}

/** Recursively sort object keys so two structurally-equal values (incl. an
 * object/array `default`) serialize identically regardless of property order. */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonicalize(obj[k])]),
    );
  }
  return v;
}

/** Canonical string for a parameter set — used to detect a real
 * parameters-only change and to feed the refinement signature. */
function paramsKey(
  params: ReadonlyArray<RoutineParameter | IRoutineParameter> | undefined,
): string {
  return JSON.stringify(
    (params ?? []).map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      required: p.required,
      default: canonicalize(p.default ?? null),
    })),
  );
}

/**
 * Stable signature for a proposed refinement: routine id + the version it
 * improves + a short hash of the new prompt AND parameters. Keys the durable
 * decline store.
 *  - Including `baseVersion` means once an edit lands (version bumps), any prior
 *    decline against the old version stops matching — a routine that drifts
 *    again later still gets a fresh offer.
 *  - Including prompt+parameters means re-proposing the *same* fix is
 *    suppressed, while a genuinely different fix — even one that changes only
 *    the parameters — still gets through.
 */
export function computeRefinementSignature(
  routineId: string,
  baseVersion: number,
  newPrompt: string,
  newParameters?: RoutineParameter[],
): string {
  const hash = createHash("sha256")
    .update(`${newPrompt} ${newParameters === undefined ? "keep" : paramsKey(newParameters)}`)
    .digest("hex")
    .slice(0, 8);
  return `refine:${routineId}#${baseVersion}#${hash}`;
}

/** Signature for a proposed retirement (disable). Version-scoped like the
 * refinement signature so a re-offer after a later edit isn't suppressed. */
export function computeRetirementSignature(routineId: string, baseVersion: number): string {
  return `retire:${routineId}#${baseVersion}`;
}

/**
 * Shared guard + raise for self-review proposals (refine and retire): the
 * durable anti-nag decline check and the one-proposal-per-chat check, then the
 * tap-to-approve bubble. Both run concurrently — independent reads. Lets
 * `raisePendingConfirmation` errors propagate; callers wrap in try/catch.
 */
async function raiseRoutineProposal(opts: {
  chatId: string;
  adapter: PlatformAdapter;
  signature: string;
  declinedReason: string;
  summary: string;
  promptText: string;
  action: { tool: string; args: Record<string, unknown> };
}): Promise<ProposalResult> {
  const { chatId, adapter, signature, declinedReason, summary, promptText, action } = opts;
  const [declined, pending] = await Promise.all([
    isRecentlyDeclined(chatId, signature),
    listPendingConfirmations(chatId),
  ]);
  if (declined) return { proposed: false, reason: declinedReason };
  // One routine proposal per chat at a time — across types — so we never stack
  // two bubbles and break iMessage's exactly-one-pending YES/NO reply path.
  if (hasPendingRoutineProposal(pending)) {
    return { proposed: false, reason: "another routine proposal is already awaiting approval" };
  }
  const confirmationId = await raisePendingConfirmation(chatId, adapter, {
    summary,
    promptText,
    ttlMs: PROPOSAL_TTL_MS,
    origin: "routine",
    action,
  });
  return { proposed: true, confirmationId };
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

function buildRetirementPrompt(input: { name: string; rationale: string }): string {
  return [
    `Disable the routine "${input.name}"? It stops running but isn't deleted — you can re-enable it anytime.`,
    ``,
    `Why: ${input.rationale}`,
  ].join("\n");
}

/**
 * Core of the refinement loop, shared by the model-facing tool and the
 * automated self-review pass. Runs the durable anti-nag guard, then raises a
 * tap-to-approve bubble whose approved action is the dispatch-only
 * `updateRoutinePrompt`. Creates nothing directly — the prompt changes only
 * after the user taps Approve. Lets `raisePendingConfirmation` errors propagate;
 * callers wrap in their own try/catch.
 */
export async function proposeRefinement(opts: {
  chatId: string;
  adapter: PlatformAdapter;
  routine: IRoutine;
  newPrompt: string;
  rationale: string;
  newParameters?: RoutineParameter[];
}): Promise<ProposalResult> {
  const { chatId, adapter, routine, newPrompt, rationale, newParameters } = opts;
  if (!routine.enabled) return { proposed: false, reason: `Routine "${routine.name}" is disabled` };

  // Reject an empty / whitespace-only prompt at the single choke point both the
  // model tool and the self-review pass funnel through — the dispatcher's
  // `.min(1)` is untrimmed, so "   " would otherwise blank the routine's prompt.
  if (newPrompt.trim().length === 0) {
    return { proposed: false, reason: "the proposed prompt is empty" };
  }

  // A refinement may change the prompt, the parameters, or both. Only bail when
  // NEITHER changed — otherwise a legitimate parameters-only fix is unreachable.
  const promptChanged = newPrompt.trim() !== routine.prompt.trim();
  const paramsChanged =
    newParameters !== undefined && paramsKey(newParameters) !== paramsKey(routine.parameters);
  if (!promptChanged && !paramsChanged) {
    return { proposed: false, reason: "the proposed prompt and parameters are unchanged" };
  }

  const signature = computeRefinementSignature(
    routine.id,
    routine.version,
    newPrompt,
    newParameters,
  );

  return raiseRoutineProposal({
    chatId,
    adapter,
    signature,
    declinedReason: "Goshujin-sama declined this refinement recently",
    summary: `Update routine "${routine.name}"`,
    promptText: buildRefinementPrompt({
      name: routine.name,
      rationale,
      oldPrompt: routine.prompt,
      newPrompt,
      paramsChanged,
    }),
    action: {
      tool: "updateRoutinePrompt",
      args: {
        signature,
        routineId: routine.id,
        baseVersion: routine.version,
        newPrompt,
        ...(newParameters !== undefined ? { newParameters } : {}),
      },
    },
  });
}

/**
 * Offer to retire (disable, not delete) a routine that's fundamentally broken
 * or obsolete. Same rail + anti-nag guard as `proposeRefinement`; approved
 * action is the dispatch-only `disableRoutine`. Used by the self-review pass.
 */
export async function proposeRetirement(opts: {
  chatId: string;
  adapter: PlatformAdapter;
  routine: IRoutine;
  rationale: string;
}): Promise<ProposalResult> {
  const { chatId, adapter, routine, rationale } = opts;
  if (!routine.enabled) {
    return { proposed: false, reason: `Routine "${routine.name}" is already disabled` };
  }

  const signature = computeRetirementSignature(routine.id, routine.version);

  return raiseRoutineProposal({
    chatId,
    adapter,
    signature,
    declinedReason: "Goshujin-sama declined retiring this routine recently",
    summary: `Disable routine "${routine.name}"`,
    promptText: buildRetirementPrompt({ name: routine.name, rationale }),
    action: {
      tool: "disableRoutine",
      args: { signature, routineId: routine.id, baseVersion: routine.version },
    },
  });
}

/**
 * Model-facing (ungated) tool that lets Mashiro offer to improve an existing
 * routine's prompt when it has been failing or returning empty results. Loads
 * the routine, then delegates to the shared `proposeRefinement` core. The prompt
 * changes only after the user taps Approve — and the refinement can never alter
 * the routine's schedule or purity (the dispatcher schema omits those fields).
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
        const result = await proposeRefinement({
          chatId,
          adapter,
          routine,
          newPrompt,
          rationale,
          newParameters,
        });
        if (result.proposed) {
          logger.debug(
            { chatId, routineId, confirmationId: result.confirmationId },
            "Tool: proposeRoutineRefinement",
          );
          return {
            proposed: true,
            confirmationId: result.confirmationId,
            message:
              "Refinement prompt sent. Stop here — don't call this again this turn. Goshujin-sama will tap Approve or Deny.",
          };
        }
        return { proposed: false, reason: result.reason };
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
