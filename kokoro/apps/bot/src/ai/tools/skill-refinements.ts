import { createHash } from "node:crypto";
import { isSkillRecentlyDeclined, type ISkill } from "@kokoro/db";
import type { PlatformAdapter } from "@kokoro/shared";
import { raiseGuardedProposal, type ProposalResult } from "./proposal-guard";

/**
 * Proposal cores for the weekly skill curation pass (`services/skill-review`):
 * refine a skill's content, archive (disable) it, or merge overlapping skills
 * into one survivor. The skill counterpart of `routine-refinements` — same
 * shared guard, same dispatch-only approval rail, keyed to the existing
 * `SkillProposalDecision` decline store. Nothing here writes directly; every
 * change lands only after Goshujin-sama taps Approve.
 */

/** The curated content fields. `enabled`, `name`, and `source` are deliberately
 * absent — curation rewrites WHAT a skill says, never renames its stable handle
 * or re-enables it. */
export interface SkillContentPatch {
  description?: string;
  body?: string;
  triggers?: string[];
  tags?: string[];
}

/** Short stable hash of a content patch, field order normalized. */
function patchHash(patch: SkillContentPatch): string {
  const canonical = JSON.stringify({
    description: patch.description ?? null,
    body: patch.body ?? null,
    triggers: patch.triggers ?? null,
    tags: patch.tags ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/**
 * Version-scoped signatures for the durable decline store, mirroring the
 * routine refinement/retirement signatures: once an edit lands (version bumps),
 * a prior decline stops matching, while re-proposing the *same* change against
 * the same version stays suppressed.
 */
export function computeSkillRefinementSignature(
  skillId: string,
  baseVersion: number,
  patch: SkillContentPatch,
): string {
  return `skill-refine:${skillId}#${baseVersion}#${patchHash(patch)}`;
}

export function computeSkillArchiveSignature(skillId: string, baseVersion: number): string {
  return `skill-archive:${skillId}#${baseVersion}`;
}

export function computeSkillMergeSignature(
  survivor: { id: string; version: number },
  absorbed: { id: string; version: number }[],
  patch: SkillContentPatch,
): string {
  const absorbedKey = absorbed
    .map((s) => `${s.id}#${s.version}`)
    .sort()
    .join(",");
  return `skill-merge:${survivor.id}#${survivor.version}<${absorbedKey}#${patchHash(patch)}`;
}

function listChanged(skill: ISkill, patch: SkillContentPatch): string[] {
  const changed: string[] = [];
  if (patch.description !== undefined && patch.description.trim() !== skill.description.trim()) {
    changed.push("description");
  }
  if (patch.body !== undefined && patch.body.trim() !== skill.body.trim()) changed.push("body");
  if (
    patch.triggers !== undefined &&
    JSON.stringify(patch.triggers) !== JSON.stringify(skill.triggers)
  ) {
    changed.push("triggers");
  }
  if (patch.tags !== undefined && JSON.stringify(patch.tags) !== JSON.stringify(skill.tags)) {
    changed.push("tags");
  }
  return changed;
}

/** Strip no-op fields so the dispatched patch (and its signature) only carries
 * real changes — two proposals differing only in echoed-back unchanged fields
 * would otherwise dodge the decline store. */
function prunePatch(skill: ISkill, patch: SkillContentPatch, changed: string[]): SkillContentPatch {
  const pruned: SkillContentPatch = {};
  if (changed.includes("description")) pruned.description = patch.description;
  if (changed.includes("body")) pruned.body = patch.body;
  if (changed.includes("triggers")) pruned.triggers = patch.triggers;
  if (changed.includes("tags")) pruned.tags = patch.tags;
  return pruned;
}

/** Render the non-body fields of a patch as `field: current → proposed` lines —
 * the bubble must show the actual values being approved, not just which fields
 * move (a metadata-only refinement would otherwise give nothing to review). */
function buildMetaChangeLines(current: ISkill, patch: SkillContentPatch): string[] {
  const fmtList = (items: string[]) => (items.length === 0 ? "(none)" : items.join(", "));
  const lines: string[] = [];
  if (patch.description !== undefined) {
    lines.push(`description: "${current.description}" → "${patch.description}"`);
  }
  if (patch.triggers !== undefined) {
    lines.push(`triggers: ${fmtList(current.triggers)} → ${fmtList(patch.triggers)}`);
  }
  if (patch.tags !== undefined) {
    lines.push(`tags: ${fmtList(current.tags)} → ${fmtList(patch.tags)}`);
  }
  return lines;
}

/**
 * Render the approval bubble for a skill refinement: why, then the body
 * before/after when the body changes (the field the user reviews closest),
 * then `current → proposed` values for every metadata field that moves.
 * Expects the PRUNED patch, so a present field is a real change.
 */
function buildSkillRefinementPrompt(input: {
  skill: ISkill;
  patch: SkillContentPatch;
  changed: string[];
  rationale: string;
}): string {
  const { skill, patch, changed, rationale } = input;
  const lines = [
    `Update the skill "${skill.name}"? (content only — it stays ${skill.enabled ? "enabled" : "disabled"} under the same name)`,
    ``,
    `Why: ${rationale}`,
  ];
  if (patch.body !== undefined && changed.includes("body")) {
    lines.push(``, `Current:`, skill.body, ``, `Proposed:`, patch.body);
  }
  const metaLines = buildMetaChangeLines(skill, patch);
  if (metaLines.length > 0) {
    lines.push(``, `Also updates:`, ...metaLines);
  }
  return lines.join("\n");
}

function buildSkillArchivePrompt(input: { name: string; rationale: string }): string {
  return [
    `Archive the skill "${input.name}"? It stops being loaded but isn't deleted — you can re-enable it anytime from the dashboard.`,
    ``,
    `Why: ${input.rationale}`,
  ].join("\n");
}

/** Expects the PRUNED patch — every metadata field present is a real change
 * the approved action will apply, so the bubble shows each one's values. */
function buildSkillMergePrompt(input: {
  survivor: ISkill;
  absorbed: ISkill[];
  patch: SkillContentPatch & { body: string };
  rationale: string;
}): string {
  const lines = [
    `Merge ${input.absorbed.length + 1} overlapping skills into "${input.survivor.name}"? ${input.absorbed
      .map((s) => `"${s.name}"`)
      .join(", ")} would be archived (disabled, not deleted).`,
    ``,
    `Why: ${input.rationale}`,
    ``,
    `Merged body:`,
    input.patch.body,
  ];
  const metaLines = buildMetaChangeLines(input.survivor, input.patch);
  if (metaLines.length > 0) {
    lines.push(``, `Also updates:`, ...metaLines);
  }
  return lines.join("\n");
}

/**
 * Offer to rewrite a skill's content (body / description / triggers / tags).
 * Equality-guarded at this single choke point — a patch that changes nothing is
 * rejected before it can burn the one-pending proposal slot. Lets
 * `raisePendingConfirmation` errors propagate; callers wrap in try/catch.
 */
export async function proposeSkillRefinement(opts: {
  chatId: string;
  adapter: PlatformAdapter;
  skill: ISkill;
  patch: SkillContentPatch;
  rationale: string;
}): Promise<ProposalResult> {
  const { chatId, adapter, skill, patch, rationale } = opts;
  if (!skill.enabled) return { proposed: false, reason: `Skill "${skill.name}" is disabled` };

  // Reject a blanking body here — the dispatcher's `.min(1)` is untrimmed, so
  // "   " would otherwise wipe the skill's content (same guard as
  // `proposeRefinement`'s empty-prompt check).
  if (patch.body !== undefined && patch.body.trim().length === 0) {
    return { proposed: false, reason: "the proposed body is empty" };
  }

  const changed = listChanged(skill, patch);
  if (changed.length === 0) {
    return { proposed: false, reason: "the proposed content is unchanged" };
  }
  const pruned = prunePatch(skill, patch, changed);

  const signature = computeSkillRefinementSignature(skill.id, skill.version, pruned);
  return raiseGuardedProposal({
    chatId,
    adapter,
    signature,
    isDeclined: isSkillRecentlyDeclined,
    declinedReason: "Goshujin-sama declined this skill update recently",
    summary: `Update skill "${skill.name}"`,
    promptText: buildSkillRefinementPrompt({ skill, patch: pruned, changed, rationale }),
    origin: "routine",
    action: {
      tool: "updateSkill",
      args: {
        signature,
        skillId: skill.id,
        baseVersion: skill.version,
        ...(pruned.description !== undefined ? { newDescription: pruned.description } : {}),
        ...(pruned.body !== undefined ? { newBody: pruned.body } : {}),
        ...(pruned.triggers !== undefined ? { newTriggers: pruned.triggers } : {}),
        ...(pruned.tags !== undefined ? { newTags: pruned.tags } : {}),
      },
    },
  });
}

/**
 * Offer to archive (disable, never delete) a stale or superseded skill. Same
 * rail + anti-nag guard as `proposeSkillRefinement`; approved action is the
 * dispatch-only `disableSkill`.
 */
export async function proposeSkillArchive(opts: {
  chatId: string;
  adapter: PlatformAdapter;
  skill: ISkill;
  rationale: string;
}): Promise<ProposalResult> {
  const { chatId, adapter, skill, rationale } = opts;
  if (!skill.enabled) {
    return { proposed: false, reason: `Skill "${skill.name}" is already disabled` };
  }

  const signature = computeSkillArchiveSignature(skill.id, skill.version);
  return raiseGuardedProposal({
    chatId,
    adapter,
    signature,
    isDeclined: isSkillRecentlyDeclined,
    declinedReason: "Goshujin-sama declined archiving this skill recently",
    summary: `Archive skill "${skill.name}"`,
    promptText: buildSkillArchivePrompt({ name: skill.name, rationale }),
    origin: "routine",
    action: {
      tool: "disableSkill",
      args: { signature, skillId: skill.id, baseVersion: skill.version },
    },
  });
}

/**
 * Offer to consolidate overlapping skills: the survivor takes the merged
 * content; the absorbed skills are archived (disabled, not deleted) in the same
 * approved action. One bubble, one tap — the whole merge is a single decision.
 */
export async function proposeSkillMerge(opts: {
  chatId: string;
  adapter: PlatformAdapter;
  survivor: ISkill;
  absorbed: ISkill[];
  patch: SkillContentPatch & { body: string };
  rationale: string;
}): Promise<ProposalResult> {
  const { chatId, adapter, survivor, absorbed, patch, rationale } = opts;
  if (!survivor.enabled) {
    return { proposed: false, reason: `Skill "${survivor.name}" is disabled` };
  }
  if (absorbed.length === 0) {
    return { proposed: false, reason: "a merge needs at least one skill to absorb" };
  }
  if (absorbed.some((s) => s.id === survivor.id)) {
    return { proposed: false, reason: "a skill cannot absorb itself" };
  }
  // A duplicate would pass dispatch preflight twice but fail its second CAS
  // after the survivor write — the dispatcher schema also rejects it, so a
  // bubble carrying one would be unapprovable. Refuse to raise it at all.
  if (new Set(absorbed.map((s) => s.id)).size !== absorbed.length) {
    return { proposed: false, reason: "absorbed skills must be distinct" };
  }
  if (absorbed.some((s) => !s.enabled)) {
    return { proposed: false, reason: "every absorbed skill must currently be enabled" };
  }
  if (patch.body.trim().length === 0) {
    return { proposed: false, reason: "the merged body is empty" };
  }

  // Prune echoed-back unchanged metadata (vs the survivor) so the bubble, the
  // signature, and the dispatched args all carry only real changes — same
  // decline-store rationale as `prunePatch` on the refine path, and it keeps
  // the bubble's "Also updates" list honest about what the tap applies.
  const metaChanged = listChanged(survivor, {
    description: patch.description,
    triggers: patch.triggers,
    tags: patch.tags,
  });
  const pruned: SkillContentPatch & { body: string } = {
    body: patch.body,
    ...prunePatch(survivor, patch, metaChanged),
  };

  const signature = computeSkillMergeSignature(
    { id: survivor.id, version: survivor.version },
    absorbed.map((s) => ({ id: s.id, version: s.version })),
    pruned,
  );
  return raiseGuardedProposal({
    chatId,
    adapter,
    signature,
    isDeclined: isSkillRecentlyDeclined,
    declinedReason: "Goshujin-sama declined this skill merge recently",
    summary: `Merge ${absorbed.length + 1} skills into "${survivor.name}"`,
    promptText: buildSkillMergePrompt({ survivor, absorbed, patch: pruned, rationale }),
    origin: "routine",
    action: {
      tool: "mergeSkills",
      args: {
        signature,
        skillId: survivor.id,
        baseVersion: survivor.version,
        absorbed: absorbed.map((s) => ({ skillId: s.id, baseVersion: s.version })),
        newBody: pruned.body,
        ...(pruned.description !== undefined ? { newDescription: pruned.description } : {}),
        ...(pruned.triggers !== undefined ? { newTriggers: pruned.triggers } : {}),
        ...(pruned.tags !== undefined ? { newTags: pruned.tags } : {}),
      },
    },
  });
}
