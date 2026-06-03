import { generateObject } from "ai";
import { z } from "zod";
import {
  getRoutineHealth,
  getRoutineById,
  getRoutineLogs,
  listChatIdsWithRoutines,
  routineNeedsAttention,
  type IRoutine,
  type RoutineHealth,
} from "@kokoro/db";
import { logger, runWithSpan } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { AdapterRegistry, platformForChatId } from "../platform/registry";
import { getModel, getModelName, ModelTier } from "../ai/provider";
import { trackUsage } from "../ai/token-tracker";
import { proposeRefinement, proposeRetirement } from "../ai/tools/routine-refinements";

// Mechanical pre-filter: the shared `routineNeedsAttention` predicate (one
// source of truth with the chat ⚠ annotation) — only routines whose recent
// *real* attempts are mostly bad reach the paid LLM review. Facts only; the LLM
// still decides what (if anything) to do.
export const needsReview = routineNeedsAttention;

// At most one routine proposal can be pending per chat (the one-tap iMessage
// invariant — see hasPendingRoutineProposal), so a run raises at most one.
const MAX_PROPOSALS_PER_RUN = 1;
// Hard cap on paid LLM reviews per chat per run. `raised` does NOT climb when a
// review returns "none" or its proposal is anti-nag-suppressed, so without this
// a chat full of chronically-declined routines would pay for a Smart-tier review
// of every one, every run. This bounds spend regardless of outcome.
const MAX_REVIEWS_PER_RUN = 6;

const REVIEW_LOG_LIMIT = 8;

const reviewSchema = z.object({
  action: z.enum(["refine", "retire", "none"]),
  newPrompt: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "Required when action is 'refine': the complete replacement prompt (max 4000 chars — the dispatcher rejects longer).",
    ),
  rationale: z
    .string()
    .describe("One line on the decision — shown to the user if a bubble is raised."),
});

type ReviewDecision = z.infer<typeof reviewSchema>;

const REVIEW_SYSTEM = `You are auditing an automated routine that has been underperforming (failing or returning empty results). Choose exactly ONE action:
- "refine": rewrite its prompt to fix the problem. Provide newPrompt — a complete replacement prompt that addresses the failures. Preserve any {parameter} references the routine relies on.
- "retire": recommend disabling it, if it is fundamentally broken, obsolete, or cannot be fixed by a prompt change.
- "none": do nothing, if there is no clear, confident fix.
Be conservative: prefer "none" over a speculative change, and prefer "refine" over "retire" whenever a prompt fix is plausible. Always give a one-line rationale.`;

function buildReviewUser(routine: IRoutine, health: RoutineHealth, recentRuns: string): string {
  const params =
    routine.parameters.length > 0
      ? routine.parameters
          .map((p) => `- ${p.name} (${p.type}${p.required ? ", required" : ""}): ${p.description}`)
          .join("\n")
      : "(none)";
  return [
    `Routine: ${routine.name}`,
    `What it does: ${routine.description}`,
    `Purity: ${routine.purity}`,
    ``,
    `Current prompt:`,
    routine.prompt,
    ``,
    `Parameters:`,
    params,
    ``,
    `Recent runs (newest first) — ${health.failedRuns} failed / ${health.emptyRuns} empty of last ${health.totalRuns}:`,
    recentRuns || "(no run history)",
  ].join("\n");
}

async function reviewRoutine(routine: IRoutine, health: RoutineHealth): Promise<ReviewDecision> {
  // Filter at the DB (matching getRoutineHealth) so composed sub-runs and
  // in-flight rows don't consume the limit window and leave the LLM with "(no
  // run history)" while the header claims failures.
  const logs = await getRoutineLogs(routine.id, REVIEW_LOG_LIMIT, {
    excludeComposed: true,
    excludeRunning: true,
  });
  const recentRuns = logs
    .map((l) => `- [${l.status}] ${(l.summary ?? "").trim().slice(0, 200) || "(no summary)"}`)
    .join("\n");

  const result = await generateObject({
    model: getModel(ModelTier.Smart),
    schema: reviewSchema,
    system: REVIEW_SYSTEM,
    messages: [{ role: "user", content: buildReviewUser(routine, health, recentRuns) }],
    temperature: 0.2,
    abortSignal: AbortSignal.timeout(60_000),
  });

  trackUsage("routine-review", getModelName(ModelTier.Smart), result.usage, {
    chatId: routine.chatId,
    routineId: routine.id,
  });

  return result.object;
}

/**
 * Audit one chat's underperforming routines and raise (gated) refinement /
 * retirement proposals. Returns the number of proposals raised. Each routine is
 * pre-filtered mechanically, reviewed by a constrained LLM pass, and any
 * proposal still passes through the durable anti-nag guard — so a routine the
 * user already said "no" to stays quiet. Exported for testing.
 */
export async function reviewChatRoutines(
  chatId: string,
  adapter: PlatformAdapter,
): Promise<number> {
  const flagged = (await getRoutineHealth(chatId)).filter(needsReview);
  if (flagged.length === 0) return 0;

  let raised = 0;
  let reviewed = 0;
  for (const health of flagged) {
    // Stop once we've raised a proposal (only one can be pending per chat) or hit
    // the review-spend cap — whichever comes first. Defer the rest to next run.
    if (raised >= MAX_PROPOSALS_PER_RUN || reviewed >= MAX_REVIEWS_PER_RUN) {
      logger.info(
        { chatId, raised, reviewed, deferred: flagged.length - reviewed },
        "Routine self-review hit a per-run cap — remaining routines deferred to the next run",
      );
      break;
    }

    const routine = await getRoutineById(health.routineId, chatId);
    if (!routine || !routine.enabled) continue;
    reviewed++;

    let decision: ReviewDecision;
    try {
      decision = await runWithSpan("routine.selfReview", () => reviewRoutine(routine, health));
    } catch (error) {
      logger.error(
        { error, chatId, routineId: health.routineId, name: routine.name },
        "Routine self-review LLM pass failed",
      );
      continue;
    }

    try {
      if (decision.action === "refine") {
        if (!decision.newPrompt) {
          logger.warn(
            { chatId, routineId: routine.id },
            "Self-review returned action=refine without a newPrompt — skipping",
          );
          continue;
        }
        const result = await proposeRefinement({
          chatId,
          adapter,
          routine,
          newPrompt: decision.newPrompt,
          rationale: decision.rationale,
        });
        if (result.proposed) raised++;
      } else if (decision.action === "retire") {
        const result = await proposeRetirement({
          chatId,
          adapter,
          routine,
          rationale: decision.rationale,
        });
        if (result.proposed) raised++;
      }
    } catch (error) {
      logger.error(
        { error, chatId, routineId: routine.id, action: decision.action },
        "Failed to raise self-review proposal",
      );
    }
  }

  return raised;
}

/**
 * Audit every chat that owns enabled routines. Resolves each chat's platform
 * adapter from the registry so it can raise approval bubbles unprompted.
 */
export async function runRoutineSelfReview(registry: AdapterRegistry): Promise<void> {
  const chatIds = await listChatIdsWithRoutines();
  if (chatIds.length === 0) return;

  for (const chatId of chatIds) {
    const adapter = registry.get(platformForChatId(chatId));
    if (!adapter) {
      logger.warn({ chatId }, "Routine self-review: no adapter registered for chat — skipping");
      continue;
    }
    try {
      const raised = await reviewChatRoutines(chatId, adapter);
      if (raised > 0) {
        logger.info({ chatId, raised }, "Routine self-review raised proposals");
      }
    } catch (error) {
      logger.error({ error, chatId }, "Routine self-review failed for chat");
    }
  }
}
