import { generateObject } from "ai";
import { z } from "zod";
import {
  getRoutineHealth,
  getRoutineById,
  getRoutineLogs,
  listChatIdsWithRoutines,
  type IRoutine,
  type RoutineHealth,
} from "@kokoro/db";
import { config, logger, runWithSpan } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { AdapterRegistry, platformForChatId } from "../platform/registry";
import { getModel, getModelName, ModelTier } from "../ai/provider";
import { trackUsage } from "../ai/token-tracker";
import { proposeRefinement, proposeRetirement } from "../ai/tools/routine-refinements";

// Mechanical pre-filter: only routines this unhealthy reach the (paid) LLM
// review. These are *facts* (a count threshold), not a judgment — the LLM still
// decides whether anything is actually wrong and what to do. Keeps the pass
// cheap and avoids second-guessing routines that are basically fine.
const MIN_RUNS_TO_REVIEW = 4;
const BAD_RATE_THRESHOLD = 0.5;

// Hard cap on proposals raised per chat per run so a flurry of broken routines
// can never flood the user with approval bubbles. Reviewing also stops once the
// cap is hit, bounding LLM spend per run.
const MAX_PROPOSALS_PER_RUN = 2;

const REVIEW_LOG_LIMIT = 8;

const reviewSchema = z.object({
  action: z.enum(["refine", "retire", "none"]),
  newPrompt: z
    .string()
    .optional()
    .describe("Required when action is 'refine': the complete replacement prompt."),
  rationale: z
    .string()
    .describe("One line on the decision — shown to the user if a bubble is raised."),
});

type ReviewDecision = z.infer<typeof reviewSchema>;

/**
 * Whether a routine's recent track record is bad enough to spend an LLM review
 * on. Facts only — `[no report]` runs are healthy and never count against it.
 */
export function needsReview(h: RoutineHealth): boolean {
  if (h.totalRuns < MIN_RUNS_TO_REVIEW) return false;
  const bad = h.failedRuns + h.emptyRuns;
  return bad / h.totalRuns >= BAD_RATE_THRESHOLD;
}

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
  const logs = await getRoutineLogs(routine.id, REVIEW_LOG_LIMIT);
  const recentRuns = logs
    .filter((l) => l.trigger !== "routine")
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
    if (raised >= MAX_PROPOSALS_PER_RUN) {
      logger.info(
        { chatId, raised, skipped: flagged.length - reviewed },
        "Routine self-review hit per-run proposal cap — remaining routines deferred",
      );
      break;
    }
    reviewed++;

    const routine = await getRoutineById(health.routineId, chatId);
    if (!routine || !routine.enabled) continue;

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
 * adapter from the registry so it can raise approval bubbles unprompted. Gated
 * by ROUTINE_PROPOSALS_ENABLED (no separate flag) — automated refinement is on
 * whenever self-authored routines are.
 */
export async function runRoutineSelfReview(registry: AdapterRegistry): Promise<void> {
  if (!config.ROUTINE_PROPOSALS_ENABLED) return;

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
