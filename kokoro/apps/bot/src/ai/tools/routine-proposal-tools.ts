import type { IPendingConfirmation } from "@kokoro/db";

/**
 * Actions raised through a routine proposal / self-review bubble: a
 * `createRoutine` save, an `updateRoutinePrompt` refinement, or a
 * `disableRoutine` retirement. Single source of truth for the three places that
 * must treat "a routine proposal" as one category:
 *  - the gated dispatcher records a durable decline on deny/cancel of any of them,
 *  - the proposal builders keep at most one pending per chat (`hasPendingRoutineProposal`),
 *  - the prompt assembler exempts them from the "stale — consider cancelling" nudge.
 *
 * Lives in its own leaf module (one type-only import) so all four consumers
 * share it without pulling the gated dispatcher's heavy service deps
 * (browser/gmail/kizuna) into one another's import graphs.
 */
export const ROUTINE_PROPOSAL_TOOLS = new Set<string>([
  "createRoutine",
  "updateRoutinePrompt",
  "disableRoutine",
]);

/**
 * True if the chat already has ANY routine proposal (save/refine/retire)
 * awaiting approval. The builders suppress on this so one chat never stacks two
 * proposal bubbles — which would drop below iMessage's exactly-one-pending
 * YES/NO reply fast path.
 */
export function hasPendingRoutineProposal(
  pending: Pick<IPendingConfirmation, "action">[],
): boolean {
  return pending.some((p) => ROUTINE_PROPOSAL_TOOLS.has(p.action.tool));
}
