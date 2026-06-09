import { fakeAdapter } from "@kokoro/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock("@kokoro/db", () => ({
  isSkillRecentlyDeclined: vi.fn(),
  listPendingConfirmations: vi.fn(),
}));

vi.mock("../../../src/ai/tools/confirmations", () => ({
  raisePendingConfirmation: vi.fn(),
}));

import { isSkillRecentlyDeclined, listPendingConfirmations } from "@kokoro/db";
import { raisePendingConfirmation } from "../../../src/ai/tools/confirmations";
import { PROPOSAL_TTL_MS } from "../../../src/ai/tools/proposal-guard";
import {
  computeSkillArchiveSignature,
  computeSkillMergeSignature,
  computeSkillRefinementSignature,
  proposeSkillArchive,
  proposeSkillMerge,
  proposeSkillRefinement,
} from "../../../src/ai/tools/skill-refinements";
import type { ISkill } from "@kokoro/db";

const adapter = fakeAdapter();
const CHAT = "chat-1";
const SKILL_ID = "666666666666666666666666";
const OTHER_ID = "777777777777777777777777";

function fakeSkill(
  over: Partial<{
    id: string;
    name: string;
    description: string;
    body: string;
    triggers: string[];
    tags: string[];
    version: number;
    enabled: boolean;
  }> = {},
): ISkill {
  return {
    _id: over.id ?? SKILL_ID,
    id: over.id ?? SKILL_ID,
    name: over.name ?? "meeting-followup-style",
    description: over.description ?? "How to write followups after meetings",
    body: over.body ?? "Use concise bullets and a single next action.",
    triggers: over.triggers ?? ["after a meeting"],
    tags: over.tags ?? ["writing"],
    version: over.version ?? 1,
    enabled: over.enabled ?? true,
  } as never;
}

beforeEach(() => {
  vi.mocked(isSkillRecentlyDeclined).mockResolvedValue(false);
  vi.mocked(listPendingConfirmations).mockResolvedValue([]);
  vi.mocked(raisePendingConfirmation).mockResolvedValue("conf-1");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("signatures", () => {
  it("refinement signature changes with the patch, the version, and the skill", () => {
    const base = computeSkillRefinementSignature(SKILL_ID, 1, { body: "a" });
    expect(base).not.toBe(computeSkillRefinementSignature(SKILL_ID, 1, { body: "b" }));
    expect(base).not.toBe(computeSkillRefinementSignature(SKILL_ID, 2, { body: "a" }));
    expect(base).not.toBe(computeSkillRefinementSignature(OTHER_ID, 1, { body: "a" }));
    expect(base).toBe(computeSkillRefinementSignature(SKILL_ID, 1, { body: "a" }));
  });

  it("refinement signature distinguishes field-omitted from field-cleared", () => {
    expect(computeSkillRefinementSignature(SKILL_ID, 1, { body: "a" })).not.toBe(
      computeSkillRefinementSignature(SKILL_ID, 1, { body: "a", tags: [] }),
    );
  });

  it("archive signature is version-scoped", () => {
    expect(computeSkillArchiveSignature(SKILL_ID, 1)).not.toBe(
      computeSkillArchiveSignature(SKILL_ID, 2),
    );
  });

  it("merge signature is stable across absorbed-list order", () => {
    const patch = { body: "merged" };
    const a = computeSkillMergeSignature(
      { id: SKILL_ID, version: 1 },
      [
        { id: OTHER_ID, version: 2 },
        { id: "888888888888888888888888", version: 1 },
      ],
      patch,
    );
    const b = computeSkillMergeSignature(
      { id: SKILL_ID, version: 1 },
      [
        { id: "888888888888888888888888", version: 1 },
        { id: OTHER_ID, version: 2 },
      ],
      patch,
    );
    expect(a).toBe(b);
  });

  it("merge signature changes when any participant's version moves", () => {
    const patch = { body: "merged" };
    const a = computeSkillMergeSignature(
      { id: SKILL_ID, version: 1 },
      [{ id: OTHER_ID, version: 1 }],
      patch,
    );
    const b = computeSkillMergeSignature(
      { id: SKILL_ID, version: 1 },
      [{ id: OTHER_ID, version: 2 }],
      patch,
    );
    expect(a).not.toBe(b);
  });
});

describe("proposeSkillRefinement", () => {
  it("rejects a disabled skill", async () => {
    const result = await proposeSkillRefinement({
      chatId: CHAT,
      adapter,
      skill: fakeSkill({ enabled: false }),
      patch: { body: "new" },
      rationale: "r",
    });
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("rejects an empty / whitespace-only body (would blank the skill)", async () => {
    const result = await proposeSkillRefinement({
      chatId: CHAT,
      adapter,
      skill: fakeSkill(),
      patch: { body: "   " },
      rationale: "r",
    });
    expect(result.proposed).toBe(false);
    expect(result.reason).toContain("empty");
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("rejects a patch that changes nothing (echoed-back content)", async () => {
    const skill = fakeSkill();
    const result = await proposeSkillRefinement({
      chatId: CHAT,
      adapter,
      skill,
      patch: { body: `  ${skill.body}  `, tags: [...skill.tags] },
      rationale: "r",
    });
    expect(result.proposed).toBe(false);
    expect(result.reason).toContain("unchanged");
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("prunes unchanged fields so the dispatched args carry only real changes", async () => {
    const skill = fakeSkill();
    const result = await proposeSkillRefinement({
      chatId: CHAT,
      adapter,
      skill,
      // body actually changes; description is echoed back unchanged.
      patch: { body: "Sharper body.", description: skill.description },
      rationale: "r",
    });

    expect(result.proposed).toBe(true);
    const raised = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(raised.action.tool).toBe("updateSkill");
    expect(raised.action.args).toMatchObject({
      skillId: SKILL_ID,
      baseVersion: 1,
      newBody: "Sharper body.",
    });
    expect(raised.action.args).not.toHaveProperty("newDescription");
    expect(raised.action.args).not.toHaveProperty("newTriggers");
    expect(raised.action.args).not.toHaveProperty("newTags");
    // The signature matches the PRUNED patch, not the raw one.
    expect(raised.action.args.signature).toBe(
      computeSkillRefinementSignature(SKILL_ID, 1, { body: "Sharper body." }),
    );
  });

  it("suppresses with declined:true when the signature was recently declined", async () => {
    vi.mocked(isSkillRecentlyDeclined).mockResolvedValue(true);
    const result = await proposeSkillRefinement({
      chatId: CHAT,
      adapter,
      skill: fakeSkill(),
      patch: { body: "new body" },
      rationale: "r",
    });
    expect(result.proposed).toBe(false);
    expect(result.declined).toBe(true);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses when another proposal (of either type) is already pending, flagged as transient", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "createRoutine", args: {} } },
    ] as never);
    const result = await proposeSkillRefinement({
      chatId: CHAT,
      adapter,
      skill: fakeSkill(),
      patch: { body: "new body" },
      rationale: "r",
    });
    expect(result.proposed).toBe(false);
    expect(result.declined).toBeUndefined();
    expect(result.suppressedByPending).toBe(true);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses when a NON-proposal confirmation (e.g. sendEmail) is pending — iMessage resolves YES/NO only with exactly one pending", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "sendEmail", args: {} } },
    ] as never);
    const result = await proposeSkillRefinement({
      chatId: CHAT,
      adapter,
      skill: fakeSkill(),
      patch: { body: "new body" },
      rationale: "r",
    });
    expect(result.proposed).toBe(false);
    expect(result.suppressedByPending).toBe(true);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("raises a 2h-TTL routine-origin bubble showing the body before/after", async () => {
    const skill = fakeSkill();
    const result = await proposeSkillRefinement({
      chatId: CHAT,
      adapter,
      skill,
      patch: { body: "Sharper body.", triggers: ["after a meeting", "before a 1:1"] },
      rationale: "Trigger list was missing the 1:1 case.",
    });

    expect(result).toEqual({ proposed: true, confirmationId: "conf-1" });
    expect(vi.mocked(raisePendingConfirmation)).toHaveBeenCalledWith(
      CHAT,
      adapter,
      expect.objectContaining({
        summary: `Update skill "${skill.name}"`,
        ttlMs: PROPOSAL_TTL_MS,
        origin: "routine",
      }),
    );
    const raised = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(raised.promptText).toContain(skill.body); // current
    expect(raised.promptText).toContain("Sharper body."); // proposed
    // Metadata changes render their VALUES, not just the field name.
    expect(raised.promptText).toContain("Also updates:");
    expect(raised.promptText).toContain(
      "triggers: after a meeting → after a meeting, before a 1:1",
    );
  });

  it("a metadata-only refinement shows current → proposed values in the bubble", async () => {
    const skill = fakeSkill();
    const result = await proposeSkillRefinement({
      chatId: CHAT,
      adapter,
      skill,
      patch: { description: "Sharper description", tags: [] },
      rationale: "r",
    });

    expect(result.proposed).toBe(true);
    const raised = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(raised.promptText).toContain(
      `description: "${skill.description}" → "Sharper description"`,
    );
    expect(raised.promptText).toContain("tags: writing → (none)");
    expect(raised.promptText).not.toContain("Proposed:"); // no body section
  });
});

describe("proposeSkillArchive", () => {
  it("rejects an already-disabled skill", async () => {
    const result = await proposeSkillArchive({
      chatId: CHAT,
      adapter,
      skill: fakeSkill({ enabled: false }),
      rationale: "r",
    });
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("raises a disableSkill action with the version-scoped signature", async () => {
    const result = await proposeSkillArchive({
      chatId: CHAT,
      adapter,
      skill: fakeSkill({ version: 3 }),
      rationale: "Never used in 90 days and reads like a one-off.",
    });

    expect(result.proposed).toBe(true);
    const raised = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(raised.action.tool).toBe("disableSkill");
    expect(raised.action.args).toEqual({
      signature: computeSkillArchiveSignature(SKILL_ID, 3),
      skillId: SKILL_ID,
      baseVersion: 3,
    });
    expect(raised.origin).toBe("routine");
  });
});

describe("proposeSkillMerge", () => {
  const survivor = fakeSkill();
  const absorbee = fakeSkill({ id: OTHER_ID, name: "followup-notes", version: 2 });
  const patch = { body: "Merged: everything still valuable from both." };

  it("rejects a disabled survivor, an empty absorb list, self-absorption, duplicate absorbees, and disabled absorbees", async () => {
    const cases = [
      { survivor: fakeSkill({ enabled: false }), absorbed: [absorbee], patch },
      { survivor, absorbed: [], patch },
      { survivor, absorbed: [fakeSkill()], patch }, // same id as survivor
      { survivor, absorbed: [absorbee, absorbee], patch }, // duplicate — second copy could never dispatch
      { survivor, absorbed: [fakeSkill({ id: OTHER_ID, enabled: false })], patch },
      { survivor, absorbed: [absorbee], patch: { body: "  " } },
    ];
    for (const c of cases) {
      const result = await proposeSkillMerge({ chatId: CHAT, adapter, rationale: "r", ...c });
      expect(result.proposed).toBe(false);
    }
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("raises a mergeSkills action carrying every participant's own baseVersion", async () => {
    const result = await proposeSkillMerge({
      chatId: CHAT,
      adapter,
      survivor,
      absorbed: [absorbee],
      patch,
      rationale: "The two skills cover the same followup procedure.",
    });

    expect(result.proposed).toBe(true);
    const raised = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(raised.action.tool).toBe("mergeSkills");
    expect(raised.action.args).toMatchObject({
      skillId: SKILL_ID,
      baseVersion: 1,
      absorbed: [{ skillId: OTHER_ID, baseVersion: 2 }],
      newBody: patch.body,
    });
    expect(raised.action.args.signature).toBe(
      computeSkillMergeSignature(
        { id: SKILL_ID, version: 1 },
        [{ id: OTHER_ID, version: 2 }],
        patch,
      ),
    );
    // The bubble names what gets archived and shows the merged body.
    expect(raised.promptText).toContain(absorbee.name);
    expect(raised.promptText).toContain(patch.body);
    expect(raised.origin).toBe("routine");
  });

  it("shows merge metadata values in the bubble and prunes echoed-back unchanged fields", async () => {
    const result = await proposeSkillMerge({
      chatId: CHAT,
      adapter,
      survivor,
      absorbed: [absorbee],
      patch: {
        body: "Merged body.",
        description: "Combined followup guidance",
        triggers: [...survivor.triggers], // echoed back unchanged
        tags: ["writing", "followup"],
      },
      rationale: "r",
    });

    expect(result.proposed).toBe(true);
    const raised = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    // Real metadata changes are dispatched AND shown with their values…
    expect(raised.action.args).toMatchObject({
      newBody: "Merged body.",
      newDescription: "Combined followup guidance",
      newTags: ["writing", "followup"],
    });
    expect(raised.promptText).toContain(
      `description: "${survivor.description}" → "Combined followup guidance"`,
    );
    expect(raised.promptText).toContain("tags: writing → writing, followup");
    // …while the echoed-back unchanged triggers are pruned from both.
    expect(raised.action.args).not.toHaveProperty("newTriggers");
    expect(raised.promptText).not.toContain("triggers:");
    // The signature matches the PRUNED patch.
    expect(raised.action.args.signature).toBe(
      computeSkillMergeSignature({ id: SKILL_ID, version: 1 }, [{ id: OTHER_ID, version: 2 }], {
        body: "Merged body.",
        description: "Combined followup guidance",
        tags: ["writing", "followup"],
      }),
    );
  });
});
