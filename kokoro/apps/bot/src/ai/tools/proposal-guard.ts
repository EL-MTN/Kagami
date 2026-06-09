import { listPendingConfirmations } from "@kokoro/db";
import type { PendingConfirmationOrigin } from "@kokoro/db";
import type { PlatformAdapter } from "@kokoro/shared";
import { raisePendingConfirmation } from "./confirmations";
import { hasPendingRoutineProposal } from "./routine-proposal-tools";
import { hasPendingSkillProposal } from "./skill-proposal-tools";

// Proposals expire faster than action confirmations (24h): an ignored "want me
// to save this?" bubble shouldn't linger for a day. Two hours is long enough
// for the user to tap, short enough that a stale offer clears on its own.
// Owned here so every proposal type (routine save/refine/retire, skill
// save/refine/archive/merge) shares one TTL that can't drift.
export const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

export interface ProposalResult {
  proposed: boolean;
  confirmationId?: string;
  reason?: string;
  /** True when suppressed specifically by the DURABLE anti-nag decline store
   * (the user said "no" recently) — distinct from a transient one-pending
   * suppression. The self-review passes use this to stop re-offering a declined
   * proposal rather than re-grading it every cycle. */
  declined?: boolean;
}

/**
 * Shared guard + raise for every proposal bubble. Runs both guards, then posts
 * the tap-to-approve bubble:
 *
 *  - GUARD 1 — durable decline memory (`isDeclined`, the caller's proposal-type
 *    decline store): honors a prior "no" past the 40-message window / 1h
 *    session reset the LLM can't see.
 *  - GUARD 2 — one proposal at a time, across ALL proposal types (routine
 *    save/refine/retire and skill save/refine/archive/merge): also protects
 *    iMessage's "exactly one pending" YES/NO resolver from stacked bubbles.
 *
 * Both guards are independent reads — run concurrently. Lets
 * `raisePendingConfirmation` errors propagate; callers wrap in try/catch.
 */
export async function raiseGuardedProposal(opts: {
  chatId: string;
  adapter: PlatformAdapter;
  signature: string;
  /** The proposal-type's durable decline store predicate
   * (`isRecentlyDeclined` for routines, `isSkillRecentlyDeclined` for skills). */
  isDeclined: (chatId: string, signature: string) => Promise<boolean>;
  declinedReason: string;
  summary: string;
  promptText: string;
  origin: PendingConfirmationOrigin;
  action: { tool: string; args: Record<string, unknown> };
}): Promise<ProposalResult> {
  const { chatId, adapter, signature, isDeclined, declinedReason, summary, promptText, origin } =
    opts;
  const [declined, pending] = await Promise.all([
    isDeclined(chatId, signature),
    listPendingConfirmations(chatId),
  ]);
  if (declined) return { proposed: false, declined: true, reason: declinedReason };
  if (hasPendingRoutineProposal(pending) || hasPendingSkillProposal(pending)) {
    return { proposed: false, reason: "another proposal is already awaiting approval" };
  }
  const confirmationId = await raisePendingConfirmation(chatId, adapter, {
    summary,
    promptText,
    ttlMs: PROPOSAL_TTL_MS,
    origin,
    action: opts.action,
  });
  return { proposed: true, confirmationId };
}
