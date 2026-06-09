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
  listChatIdsWithSkills: vi.fn(),
  listEnabledSkillsForChat: vi.fn(),
  markSkillsReviewed: vi.fn(),
  // Real-equivalent predicate so the orchestration tests select the same rows
  // the production code would. The predicate itself is unit-tested in the db
  // model (never-reviewed always due; otherwise stale ≥30d AND cooldown ≥30d).
  skillNeedsReview: (
    s: {
      enabled: boolean;
      createdAt: Date;
      lastUsedAt: Date | null;
      lastReviewedAt: Date | null;
    },
    now: Date,
  ) => {
    if (!s.enabled) return false;
    if (!s.lastReviewedAt) return true;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const stale = now.getTime() - (s.lastUsedAt ?? s.createdAt).getTime() >= 30 * DAY_MS;
    const cooled = now.getTime() - s.lastReviewedAt.getTime() >= 30 * DAY_MS;
    return stale && cooled;
  },
}));

vi.mock("ai", () => ({ generateObject: vi.fn() }));

vi.mock("../../src/ai/provider", () => ({
  getModel: vi.fn(() => ({})),
  getModelName: vi.fn(() => "claude-sonnet-4-6"),
  ModelTier: { Default: "default", Fast: "fast", Smart: "smart" },
}));

vi.mock("../../src/ai/token-tracker", () => ({ trackUsage: vi.fn() }));

vi.mock("../../src/ai/tools/skill-refinements", () => ({
  proposeSkillRefinement: vi.fn(),
  proposeSkillArchive: vi.fn(),
  proposeSkillMerge: vi.fn(),
}));

import { generateObject } from "ai";
import { listEnabledSkillsForChat, markSkillsReviewed } from "@kokoro/db";
import { trackUsage } from "../../src/ai/token-tracker";
import {
  proposeSkillArchive,
  proposeSkillMerge,
  proposeSkillRefinement,
} from "../../src/ai/tools/skill-refinements";
import { reviewChatSkills } from "../../src/services/skill-review";

const adapter = fakeAdapter();
const CHAT = "chat-1";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// Default skill: never reviewed → always a due candidate.
function skill(over: Record<string, unknown> = {}) {
  const name = (over.name as string) ?? "inbox-style";
  return {
    id: `id-${name}`,
    chatId: CHAT,
    name,
    description: `Description of ${name}`,
    body: `Body of ${name}.`,
    triggers: [],
    tags: [],
    enabled: true,
    version: 1,
    usageCount: 0,
    lastUsedAt: null,
    lastReviewedAt: null,
    createdAt: daysAgo(60),
    updatedAt: daysAgo(60),
    ...over,
  } as never;
}

/** Expected `markSkillsReviewed` payload — every fixture above is version 1. */
const stamped = (ids: string[]) => ids.map((id) => ({ id, version: 1 }));

function llmActions(actions: Record<string, unknown>[]) {
  vi.mocked(generateObject).mockResolvedValue({
    object: { actions },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  } as never);
}

/** The user message of the single review call. */
function userMessage(): string {
  const call = vi.mocked(generateObject).mock.calls[0]?.[0] as unknown as {
    messages: { content: string }[];
  };
  return call.messages[0].content;
}

beforeEach(() => {
  vi.mocked(listEnabledSkillsForChat).mockResolvedValue([skill()] as never);
  vi.mocked(markSkillsReviewed).mockResolvedValue(undefined);
  llmActions([]);
  vi.mocked(proposeSkillRefinement).mockResolvedValue({ proposed: true, confirmationId: "c1" });
  vi.mocked(proposeSkillArchive).mockResolvedValue({ proposed: true, confirmationId: "c2" });
  vi.mocked(proposeSkillMerge).mockResolvedValue({ proposed: true, confirmationId: "c3" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("reviewChatSkills — candidate selection", () => {
  it("does nothing for a chat with no enabled skills", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([] as never);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    expect(vi.mocked(markSkillsReviewed)).not.toHaveBeenCalled();
  });

  it("does not call the LLM when no skill is due for review", async () => {
    // Recently reviewed AND recently active → the facts-only pre-filter gates
    // the paid call entirely.
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ lastReviewedAt: daysAgo(5), lastUsedAt: daysAgo(2) }),
    ] as never);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    expect(vi.mocked(markSkillsReviewed)).not.toHaveBeenCalled();
  });

  it("reviews a whole chat in ONE LLM call, however many candidates are due", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "a" }),
      skill({ name: "b" }),
      skill({ name: "c" }),
    ] as never);

    await reviewChatSkills(CHAT, adapter);

    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(1);
  });

  it("includes non-due skills as catalog context but not as reviewable detail", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "stale-one" }),
      skill({ name: "fresh-one", lastReviewedAt: daysAgo(5), lastUsedAt: daysAgo(2) }),
    ] as never);

    await reviewChatSkills(CHAT, adapter);

    const prompt = userMessage();
    expect(prompt).toContain("### stale-one");
    expect(prompt).toContain("- fresh-one —"); // catalog line
    expect(prompt).not.toContain("### fresh-one"); // no detail block
    // Only the candidate gets stamped — the fresh skill stays on its cooldown clock.
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(["id-stale-one"]),
      expect.any(Date),
    );
  });

  it("orders never-reviewed (oldest created) before stale re-reviews, capped at 8", async () => {
    const neverReviewed = Array.from({ length: 6 }, (_, i) =>
      // nr-0 created longest ago → first.
      skill({ name: `nr-${i}`, createdAt: daysAgo(100 - i) }),
    );
    const stale = Array.from({ length: 4 }, (_, i) =>
      // st-0 idle longest → first among the stale.
      skill({ name: `st-${i}`, lastReviewedAt: daysAgo(45), lastUsedAt: daysAgo(90 - i) }),
    );
    // Interleave so input order can't accidentally produce the expected output.
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      stale[3],
      neverReviewed[2],
      stale[0],
      ...neverReviewed.filter((_, i) => i !== 2),
      stale[1],
      stale[2],
    ] as never);

    await reviewChatSkills(CHAT, adapter);

    const reviewed = [...userMessage().matchAll(/^### (\S+)/gm)].map((m) => m[1]);
    // 10 due, cap 8: all 6 never-reviewed (created asc), then the 2 longest-idle stale.
    expect(reviewed).toEqual(["nr-0", "nr-1", "nr-2", "nr-3", "nr-4", "nr-5", "st-0", "st-1"]);
    // Only the reviewed 8 are stamped — the deferred tail stays due next cycle.
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(reviewed.map((n) => `id-${n}`)),
      expect.any(Date),
    );
  });
});

describe("reviewChatSkills — action dispatch", () => {
  it("routes a refine to proposeSkillRefinement with only the changed fields", async () => {
    llmActions([
      {
        action: "refine",
        skillName: "inbox-style",
        newBody: "Tighter body.",
        newDescription: "Tighter description",
        rationale: "outdated",
      },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeSkillRefinement)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(proposeSkillRefinement).mock.calls[0]?.[0];
    expect(arg?.chatId).toBe(CHAT);
    expect(arg?.adapter).toBe(adapter);
    expect(arg?.skill.id).toBe("id-inbox-style");
    // Omitted fields (triggers/tags) must not appear in the patch at all.
    expect(arg?.patch).toEqual({ body: "Tighter body.", description: "Tighter description" });
    expect(arg?.rationale).toBe("outdated");
    expect(vi.mocked(proposeSkillArchive)).not.toHaveBeenCalled();
    expect(vi.mocked(proposeSkillMerge)).not.toHaveBeenCalled();
  });

  it("routes an archive to proposeSkillArchive", async () => {
    llmActions([{ action: "archive", skillName: "inbox-style", rationale: "never used" }]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeSkillArchive)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(proposeSkillArchive).mock.calls[0]?.[0];
    expect(arg?.chatId).toBe(CHAT);
    expect(arg?.adapter).toBe(adapter);
    expect(arg?.skill.id).toBe("id-inbox-style");
    expect(arg?.rationale).toBe("never used");
  });

  it("routes a merge to proposeSkillMerge with the resolved absorbees", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "survivor" }),
      skill({ name: "dupe-a" }),
      skill({ name: "dupe-b" }),
    ] as never);
    llmActions([
      {
        action: "merge",
        skillName: "survivor",
        absorbNames: ["dupe-a", "dupe-b"],
        newBody: "The merged body.",
        rationale: "duplicates",
      },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeSkillMerge)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(proposeSkillMerge).mock.calls[0]?.[0];
    expect(arg?.chatId).toBe(CHAT);
    expect(arg?.adapter).toBe(adapter);
    expect(arg?.survivor.id).toBe("id-survivor");
    expect(arg?.absorbed.map((s) => s.id)).toEqual(["id-dupe-a", "id-dupe-b"]);
    expect(arg?.patch).toEqual({ body: "The merged body." });
    expect(arg?.rationale).toBe("duplicates");
  });

  it("dedupes a repeated absorbName before resolving — the core never sees duplicates", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "survivor" }),
      skill({ name: "dupe-a" }),
      skill({ name: "dupe-b" }),
    ] as never);
    llmActions([
      {
        action: "merge",
        skillName: "survivor",
        absorbNames: ["dupe-a", "dupe-a", "dupe-b"],
        newBody: "The merged body.",
        rationale: "duplicates",
      },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeSkillMerge)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(proposeSkillMerge).mock.calls[0]?.[0];
    expect(arg?.absorbed.map((s) => s.id)).toEqual(["id-dupe-a", "id-dupe-b"]);
  });

  it("stops after the first raised proposal (one pending per chat)", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "a" }),
      skill({ name: "b" }),
    ] as never);
    llmActions([
      { action: "archive", skillName: "a", rationale: "first" },
      { action: "archive", skillName: "b", rationale: "backup" },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1); // MAX_PROPOSALS_PER_RUN
    expect(vi.mocked(proposeSkillArchive)).toHaveBeenCalledTimes(1);
    // The cap-deferred action's skill is NOT stamped — the next cycle
    // re-derives it instead of burying it under the 30-day cooldown.
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(["id-a"]),
      expect.any(Date),
    );
  });

  it("falls through to the next-ranked action when a proposal is suppressed (anti-nag)", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "a" }),
      skill({ name: "b" }),
    ] as never);
    llmActions([
      { action: "refine", skillName: "a", newBody: "x", rationale: "first" },
      { action: "archive", skillName: "b", rationale: "backup" },
    ]);
    vi.mocked(proposeSkillRefinement).mockResolvedValue({
      proposed: false,
      declined: true,
      reason: "declined recently",
    });

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeSkillRefinement)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(proposeSkillArchive)).toHaveBeenCalledTimes(1);
    // A durable decline is a terminal outcome — both skills are stamped.
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(["id-a", "id-b"]),
      expect.any(Date),
    );
  });

  it("falls through when a proposal core throws, without aborting the run", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "a" }),
      skill({ name: "b" }),
    ] as never);
    llmActions([
      { action: "archive", skillName: "a", rationale: "first" },
      { action: "archive", skillName: "b", rationale: "backup" },
    ]);
    vi.mocked(proposeSkillArchive)
      .mockRejectedValueOnce(new Error("adapter down"))
      .mockResolvedValueOnce({ proposed: true, confirmationId: "c9" });

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeSkillArchive)).toHaveBeenCalledTimes(2);
    // The thrown attempt leaves "a" un-stamped (its action never reached a
    // terminal outcome — retried next cycle); the landed proposal stamps "b".
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(["id-b"]),
      expect.any(Date),
    );
  });
});

describe("reviewChatSkills — malformed LLM actions", () => {
  it("skips an action naming a skill outside the reviewed candidates", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "under-review" }),
      // Catalog-only context — NOT a candidate, so not actionable.
      skill({ name: "fresh-one", lastReviewedAt: daysAgo(5), lastUsedAt: daysAgo(2) }),
    ] as never);
    llmActions([
      { action: "archive", skillName: "fresh-one", rationale: "named catalog skill" },
      { action: "archive", skillName: "under-review", rationale: "valid backup" },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    // Invalid ref skipped, falls through to the valid action.
    expect(raised).toBe(1);
    expect(vi.mocked(proposeSkillArchive)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(proposeSkillArchive).mock.calls[0]?.[0]?.skill.name).toBe("under-review");
  });

  it("skips a refine with no content fields — terminal, so the candidate is still stamped", async () => {
    llmActions([{ action: "refine", skillName: "inbox-style", rationale: "nothing to change" }]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeSkillRefinement)).not.toHaveBeenCalled();
    // Re-deriving a malformed action next cycle reaches the same dead end.
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(["id-inbox-style"]),
      expect.any(Date),
    );
  });

  it("skips a merge missing absorbNames or a merged body", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "a" }),
      skill({ name: "b" }),
    ] as never);
    llmActions([
      { action: "merge", skillName: "a", newBody: "merged", rationale: "no absorbees" },
      {
        action: "merge",
        skillName: "a",
        absorbNames: ["b"],
        newBody: "   ",
        rationale: "blank body",
      },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeSkillMerge)).not.toHaveBeenCalled();
  });

  it("skips a merge whose absorbee is unknown or the survivor itself", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "a" }),
      skill({ name: "b" }),
    ] as never);
    llmActions([
      {
        action: "merge",
        skillName: "a",
        absorbNames: ["ghost"],
        newBody: "m",
        rationale: "unknown",
      },
      { action: "merge", skillName: "a", absorbNames: ["a"], newBody: "m", rationale: "self" },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeSkillMerge)).not.toHaveBeenCalled();
  });
});

describe("reviewChatSkills — disposition-aware stamping", () => {
  it("leaves skills un-stamped when their action was transiently suppressed by a pending confirmation", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "a" }),
      skill({ name: "b" }),
      skill({ name: "c" }),
    ] as never);
    llmActions([
      { action: "refine", skillName: "a", newBody: "x", rationale: "r1" },
      { action: "archive", skillName: "b", rationale: "r2" },
    ]);
    const suppressed = {
      proposed: false,
      suppressedByPending: true,
      reason: "another confirmation is already awaiting approval",
    };
    vi.mocked(proposeSkillRefinement).mockResolvedValue(suppressed);
    vi.mocked(proposeSkillArchive).mockResolvedValue(suppressed);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(0);
    // a and b retry next cycle once the pending slot frees; c (no action
    // targeted it) is terminally reviewed and starts its cooldown.
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(["id-c"]),
      expect.any(Date),
    );
  });

  it("leaves EVERY merge participant un-stamped when the merge is deferred by the proposal cap", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "a" }),
      skill({ name: "survivor" }),
      skill({ name: "dupe" }),
    ] as never);
    llmActions([
      { action: "archive", skillName: "a", rationale: "first" },
      {
        action: "merge",
        skillName: "survivor",
        absorbNames: ["dupe"],
        newBody: "m",
        rationale: "deferred",
      },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeSkillMerge)).not.toHaveBeenCalled();
    // Survivor AND absorbee stay un-stamped — the whole merge re-derives.
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(["id-a"]),
      expect.any(Date),
    );
  });
});

describe("reviewChatSkills — blank-metadata normalization", () => {
  it("drops a blank description and trims/drops blank list items before the patch reaches the core", async () => {
    llmActions([
      {
        action: "refine",
        skillName: "inbox-style",
        newBody: "Tight body.",
        newDescription: "   ",
        newTriggers: ["  after a meeting  ", "   "],
        rationale: "r",
      },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    const arg = vi.mocked(proposeSkillRefinement).mock.calls[0]?.[0];
    // Blank description omitted (the dispatcher's .min(1) would reject it on
    // Approve); items trimmed, blanks dropped.
    expect(arg?.patch).toEqual({ body: "Tight body.", triggers: ["after a meeting"] });
  });

  it("treats a provided-but-all-blank list as omitted (no accidental clear)", async () => {
    llmActions([
      {
        action: "refine",
        skillName: "inbox-style",
        newBody: "Tight body.",
        newTriggers: ["   ", ""],
        rationale: "r",
      },
    ]);

    await reviewChatSkills(CHAT, adapter);

    const arg = vi.mocked(proposeSkillRefinement).mock.calls[0]?.[0];
    expect(arg?.patch).toEqual({ body: "Tight body." });
  });

  it("passes an explicit empty list through as a legitimate clear", async () => {
    llmActions([
      {
        action: "refine",
        skillName: "inbox-style",
        newBody: "Tight body.",
        newTags: [],
        rationale: "r",
      },
    ]);

    await reviewChatSkills(CHAT, adapter);

    const arg = vi.mocked(proposeSkillRefinement).mock.calls[0]?.[0];
    expect(arg?.patch).toEqual({ body: "Tight body.", tags: [] });
  });

  it("omits a whitespace-only newBody (a refine never blanks a skill) and trims the description", async () => {
    llmActions([
      {
        action: "refine",
        skillName: "inbox-style",
        newBody: "   ",
        newDescription: "  Sharper.  ",
        rationale: "r",
      },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    const arg = vi.mocked(proposeSkillRefinement).mock.calls[0]?.[0];
    expect(arg?.patch).toEqual({ description: "Sharper." });
  });

  it("skips a refine whose every field normalizes away, instead of raising an unapprovable bubble", async () => {
    llmActions([
      {
        action: "refine",
        skillName: "inbox-style",
        newDescription: " ",
        newTriggers: [" "],
        rationale: "r",
      },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeSkillRefinement)).not.toHaveBeenCalled();
    // Terminal disposition — the candidate is still stamped.
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(["id-inbox-style"]),
      expect.any(Date),
    );
  });

  it("normalizes merge metadata the same way", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "survivor" }),
      skill({ name: "dupe" }),
    ] as never);
    llmActions([
      {
        action: "merge",
        skillName: "survivor",
        absorbNames: ["dupe"],
        newBody: "Merged.",
        newDescription: "  ",
        newTags: [" keep ", " "],
        rationale: "r",
      },
    ]);

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
    const arg = vi.mocked(proposeSkillMerge).mock.calls[0]?.[0];
    expect(arg?.patch).toEqual({ body: "Merged.", tags: ["keep"] });
  });
});

describe("reviewChatSkills — bookkeeping", () => {
  it("tracks token usage under the skill-review category", async () => {
    await reviewChatSkills(CHAT, adapter);

    expect(vi.mocked(trackUsage)).toHaveBeenCalledWith(
      "skill-review",
      "claude-sonnet-4-6",
      expect.objectContaining({ totalTokens: 15 }),
      { chatId: CHAT },
    );
  });

  it("stamps every candidate as reviewed even on a no-action verdict", async () => {
    vi.mocked(listEnabledSkillsForChat).mockResolvedValue([
      skill({ name: "a" }),
      skill({ name: "b" }),
    ] as never);
    llmActions([]); // healthy library

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(0);
    // The cooldown must start anyway, or the same skills get re-billed weekly.
    expect(vi.mocked(markSkillsReviewed)).toHaveBeenCalledWith(
      CHAT,
      stamped(["id-a", "id-b"]),
      expect.any(Date),
    );
  });

  it("returns 0 and stamps nothing when the LLM pass fails", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("llm down"));

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeSkillRefinement)).not.toHaveBeenCalled();
    // No stamp → these candidates are re-reviewed next cycle instead of
    // silently skipping a whole cohort on a transient failure.
    expect(vi.mocked(markSkillsReviewed)).not.toHaveBeenCalled();
  });

  it("treats a failed stamp as best-effort (still reports the raised count)", async () => {
    llmActions([{ action: "archive", skillName: "inbox-style", rationale: "obsolete" }]);
    vi.mocked(markSkillsReviewed).mockRejectedValue(new Error("write failed"));

    const raised = await reviewChatSkills(CHAT, adapter);

    expect(raised).toBe(1);
  });
});
