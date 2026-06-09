/**
 * Dispatch-only actions raised by skill proposal bubbles — the conversation
 * `proposeSkill` save plus the skill-review curation proposals (refine /
 * archive / merge). Kept in a leaf module so the tool registry, proposal
 * builder, prompt assembler, and gated dispatcher can agree without creating an
 * import cycle. Membership feeds the deny/cancel decline recorder and the
 * prompt assembler's stale-nudge exemption. (The one-pending proposal guard in
 * `proposal-guard.ts` no longer consults this set — it suppresses on ANY
 * pending confirmation, proposal or not.)
 */
export const SKILL_PROPOSAL_TOOLS = new Set<string>([
  "createSkill",
  "updateSkill",
  "disableSkill",
  "mergeSkills",
]);
