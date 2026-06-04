import { generateObject } from "ai";
import { z } from "zod";
import {
  clearRefineTracking,
  getRoutineHealth,
  getRoutineById,
  getRoutineLogs,
  listChatIdsWithRoutines,
  listRoutinesAwaitingPostRefineReview,
  recordRoutineGrade,
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
const needsReview = routineNeedsAttention;

// At most one routine proposal can be pending per chat (the one-tap iMessage
// invariant — see hasPendingRoutineProposal), so a run raises at most one.
const MAX_PROPOSALS_PER_RUN = 1;
// Hard cap on paid LLM reviews per chat per run. `raised` does NOT climb when a
// review returns "none" or its proposal is anti-nag-suppressed, so without this
// a chat full of chronically-declined routines would pay for a Smart-tier review
// of every one, every run. This bounds spend regardless of outcome.
const MAX_REVIEWS_PER_RUN = 6;

// --- Loop-closure tuning (policy lives here, caller-side; the db model stays
// facts-only). ---
// A refined routine is re-graded once it has accumulated this many fresh real
// runs, so the grade reflects the new prompt rather than the old one.
const MIN_RUNS_TO_REGRADE = 3;
// A revert is offered only when the post-edit grade falls at least this far
// below the pre-edit grade — a margin so ordinary grade jitter doesn't read as a
// regression. Grades are 0-100.
const REGRESSION_MARGIN = 15;

const reviewSchema = z.object({
  grade: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      "Quality of the routine's recent performance, 0-100: how reliably it fulfills its stated purpose AND produces output worth acting on.",
    ),
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

const REVIEW_SYSTEM = `You audit one automated routine: first GRADE its recent performance, then choose at most one corrective action.

Grade (0-100) — how well it fulfills its stated purpose AND produces output worth acting on, judged from its recent runs:
- 80-100: reliably does its job; the output is genuinely useful.
- 40-79: runs, but is noisy, shallow, partially failing, or of marginal value.
- 0-39: mostly failing, empty, or off-target.
Weigh BOTH reliability (failed / empty runs) and value (would the user actually act on this output) — not merely whether it executed.

Action — choose exactly ONE:
- "refine": rewrite its prompt to fix the problem. Provide newPrompt — a complete replacement prompt that addresses the failures. Preserve any {parameter} references the routine relies on.
- "retire": recommend disabling it, if it is fundamentally broken, obsolete, or cannot be fixed by a prompt change.
- "none": do nothing — a healthy routine, or one with no clear, confident fix, takes "none".
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
  // Filter at the DB (same helper as getRoutineHealth) so composed sub-runs and
  // in-flight rows don't consume the window, AND use the SAME window the health
  // counts came from — otherwise the header ("N failed of M") could claim more
  // failures than the listed rows show.
  const logs = await getRoutineLogs(routine.id, health.window, {
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
 * Audit one chat's routines: GRADE each candidate, raise (gated) refinement /
 * retirement / revert proposals, and persist the grade so the next cycle can
 * tell whether a fix helped. Returns the number of proposals raised.
 *
 * Two candidate sources, post-refine first (loop closure is the higher-value
 * signal):
 *  1. routines whose last edit has now run enough times to judge
 *     (`listRoutinesAwaitingPostRefineReview`), so a silently-worse edit is
 *     caught even when the routine still looks healthy; and
 *  2. routines whose recent record trips the mechanical bad-rate pre-filter
 *     (`routineNeedsAttention`).
 *
 * Every candidate is graded by a constrained LLM pass; a regressed post-refine
 * routine is offered a revert to its previous prompt, otherwise the LLM's
 * refine/retire/none decision stands. Each proposal still passes the durable
 * anti-nag guard, so a routine the user already said "no" to stays quiet.
 * Exported for testing.
 */
export async function reviewChatRoutines(
  chatId: string,
  adapter: PlatformAdapter,
): Promise<number> {
  const allHealth = await getRoutineHealth(chatId);
  if (allHealth.length === 0) return 0;
  const healthById = new Map(allHealth.map((h) => [h.routineId, h]));

  const postRefineIds = await listRoutinesAwaitingPostRefineReview(chatId, MIN_RUNS_TO_REGRADE);
  const postRefineSet = new Set(postRefineIds);
  const flaggedIds = allHealth.filter(needsReview).map((h) => h.routineId);

  // Post-refine ids first, then flagged; dedupe, keeping only currently-enabled
  // routines (healthById is built from enabled routines only).
  const candidateIds: string[] = [];
  const seen = new Set<string>();
  for (const id of [...postRefineIds, ...flaggedIds]) {
    if (!seen.has(id) && healthById.has(id)) {
      seen.add(id);
      candidateIds.push(id);
    }
  }
  if (candidateIds.length === 0) return 0;

  let raised = 0;
  let reviewed = 0;
  for (const id of candidateIds) {
    // Stop once we've raised a proposal (only one can be pending per chat) or hit
    // the review-spend cap — whichever comes first. Defer the rest to next run.
    if (raised >= MAX_PROPOSALS_PER_RUN || reviewed >= MAX_REVIEWS_PER_RUN) {
      logger.info(
        { chatId, raised, reviewed, deferred: candidateIds.length - reviewed },
        "Routine self-review hit a per-run cap — remaining routines deferred to the next run",
      );
      break;
    }

    const routine = await getRoutineById(id, chatId);
    if (!routine || !routine.enabled) continue;
    const health = healthById.get(id);
    if (!health) continue;
    reviewed++;

    let decision: ReviewDecision;
    try {
      decision = await runWithSpan("routine.selfReview", () => reviewRoutine(routine, health));
    } catch (error) {
      logger.error(
        { error, chatId, routineId: id, name: routine.name },
        "Routine self-review LLM pass failed",
      );
      continue;
    }

    // Persist the grade (best-effort) — the measurement half of loop closure, so
    // a later cycle can compare this routine's grade before vs after its next
    // edit. Independent of whether a proposal is raised below.
    await recordRoutineGrade(id, decision.grade).catch((error) => {
      logger.warn({ error, chatId, routineId: id }, "Failed to persist routine grade");
    });

    const isPostRefine = postRefineSet.has(id);
    try {
      const { priorPrompt, preRefineGrade } = routine;
      const regressed =
        isPostRefine &&
        preRefineGrade !== null &&
        !!priorPrompt?.trim() &&
        decision.grade <= preRefineGrade - REGRESSION_MARGIN;

      if (regressed && priorPrompt && preRefineGrade !== null) {
        // Loop closure: the last edit measurably lowered quality — offer to
        // revert to the prompt that scored better. trackForRegression:false so
        // the revert itself isn't watched (no ping-pong between two prompts).
        const result = await proposeRefinement({
          chatId,
          adapter,
          routine,
          newPrompt: priorPrompt,
          rationale: `Quality dropped after the last edit (graded ${preRefineGrade}→${decision.grade}); revert to the previous version.`,
          trackForRegression: false,
        });
        if (result.proposed) raised++;
      } else if (decision.action === "refine") {
        if (!decision.newPrompt?.trim()) {
          logger.warn(
            { chatId, routineId: id },
            "Self-review returned action=refine without a usable newPrompt — skipping",
          );
        } else {
          const result = await proposeRefinement({
            chatId,
            adapter,
            routine,
            newPrompt: decision.newPrompt,
            rationale: decision.rationale,
          });
          if (result.proposed) raised++;
        }
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
        { error, chatId, routineId: id, action: decision.action },
        "Failed to raise self-review proposal",
      );
    } finally {
      // A post-refine routine has now had its verdict rendered (graded with
      // enough fresh runs) — graduate it so we stop re-grading against the old
      // baseline. If a forward refinement was just proposed, its approval
      // re-arms tracking fresh; a revert clears the same fields on apply.
      if (isPostRefine) {
        await clearRefineTracking(id).catch((error) => {
          logger.warn({ error, chatId, routineId: id }, "Failed to clear refine tracking");
        });
      }
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
