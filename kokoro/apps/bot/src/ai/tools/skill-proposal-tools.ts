import type { IPendingConfirmation } from "@kokoro/db";

/**
 * Dispatch-only actions raised by skill proposal bubbles — the conversation
 * `proposeSkill` save plus the skill-review curation proposals (refine /
 * archive / merge). Kept in a leaf module so the tool registry, proposal
 * builder, prompt assembler, and gated dispatcher can agree without creating an
 * import cycle. Membership feeds both the one-pending-proposal guard and the
 * deny/cancel decline recorder.
 */
export const SKILL_PROPOSAL_TOOLS = new Set<string>([
  "createSkill",
  "updateSkill",
  "disableSkill",
  "mergeSkills",
]);

export function hasPendingSkillProposal(pending: Pick<IPendingConfirmation, "action">[]): boolean {
  return pending.some((p) => SKILL_PROPOSAL_TOOLS.has(p.action.tool));
}
