import type { IPendingConfirmation } from "@kokoro/db";

/**
 * Dispatch-only actions raised by skill proposal bubbles. Kept in a leaf module
 * so the tool registry, proposal builder, prompt assembler, and gated
 * dispatcher can agree without creating an import cycle.
 */
export const SKILL_PROPOSAL_TOOLS = new Set<string>(["createSkill"]);

export function hasPendingSkillProposal(pending: Pick<IPendingConfirmation, "action">[]): boolean {
  return pending.some((p) => SKILL_PROPOSAL_TOOLS.has(p.action.tool));
}
