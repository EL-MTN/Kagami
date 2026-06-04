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
  getRoutineHealth: vi.fn(),
  getRoutineById: vi.fn(),
  getRoutineLogs: vi.fn(),
  listChatIdsWithRoutines: vi.fn(),
  listRoutinesAwaitingPostRefineReview: vi.fn(),
  recordRoutineGrade: vi.fn(),
  clearRefineTracking: vi.fn(),
  // Real-equivalent predicate so the orchestration tests flag the same rows the
  // production code would. The predicate itself is unit-tested in the db model.
  routineNeedsAttention: (h: {
    totalRuns: number;
    failedRuns: number;
    emptyRuns: number;
    noReportRuns: number;
  }) => {
    const real = h.totalRuns - h.noReportRuns;
    return real >= 4 && (h.failedRuns + h.emptyRuns) / real >= 0.5;
  },
}));

vi.mock("ai", () => ({ generateObject: vi.fn() }));

vi.mock("../../src/ai/provider", () => ({
  getModel: vi.fn(() => ({})),
  getModelName: vi.fn(() => "claude-sonnet-4-6"),
  ModelTier: { Default: "default", Fast: "fast", Smart: "smart" },
}));

vi.mock("../../src/ai/token-tracker", () => ({ trackUsage: vi.fn() }));

vi.mock("../../src/ai/tools/routine-refinements", () => ({
  proposeRefinement: vi.fn(),
  proposeRetirement: vi.fn(),
}));

import { generateObject } from "ai";
import {
  getRoutineHealth,
  getRoutineById,
  getRoutineLogs,
  listRoutinesAwaitingPostRefineReview,
  recordRoutineGrade,
  clearRefineTracking,
} from "@kokoro/db";
import { proposeRefinement, proposeRetirement } from "../../src/ai/tools/routine-refinements";
import { reviewChatRoutines } from "../../src/services/routine-review";

const adapter = fakeAdapter();
const CHAT = "chat-1";

function health(over: Record<string, unknown> = {}) {
  return {
    routineId: "r1",
    name: "digest",
    window: 10,
    totalRuns: 6,
    failedRuns: 4,
    emptyRuns: 0,
    noReportRuns: 0,
    lastStatus: "failed",
    lastError: "boom",
    lastRunAt: new Date(),
    ...over,
  } as never;
}

function routine(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    chatId: CHAT,
    name: "digest",
    description: "summarize inbox",
    prompt: "Summarize the inbox.",
    purity: "read",
    parameters: [],
    enabled: true,
    version: 1,
    ...over,
  } as never;
}

function llmDecision(object: Record<string, unknown>) {
  vi.mocked(generateObject).mockResolvedValue({
    // grade is required by the schema — default it so callers that only care
    // about the action don't have to spell it out.
    object: { grade: 70, ...object },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  } as never);
}

beforeEach(() => {
  vi.mocked(getRoutineHealth).mockResolvedValue([health()]);
  vi.mocked(getRoutineById).mockImplementation((id: string) => Promise.resolve(routine({ id })));
  vi.mocked(getRoutineLogs).mockResolvedValue([]);
  vi.mocked(listRoutinesAwaitingPostRefineReview).mockResolvedValue([]);
  vi.mocked(recordRoutineGrade).mockResolvedValue(undefined);
  vi.mocked(clearRefineTracking).mockResolvedValue(undefined);
  llmDecision({ action: "none", rationale: "looks fine" });
  vi.mocked(proposeRefinement).mockResolvedValue({ proposed: true, confirmationId: "c1" });
  vi.mocked(proposeRetirement).mockResolvedValue({ proposed: true, confirmationId: "c2" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("reviewChatRoutines", () => {
  it("does not call the LLM when no routine is unhealthy enough", async () => {
    vi.mocked(getRoutineHealth).mockResolvedValue([health({ failedRuns: 1, totalRuns: 6 })]);

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    expect(vi.mocked(proposeRefinement)).not.toHaveBeenCalled();
  });

  it("fetches the review run-history over the SAME window as the health counts", async () => {
    // Otherwise the prompt header ("N failed of M") could claim more failures
    // than the listed rows show. health().window === 10.
    llmDecision({ action: "none", rationale: "fine" });

    await reviewChatRoutines(CHAT, adapter);

    expect(vi.mocked(getRoutineLogs)).toHaveBeenCalledWith("r1", 10, {
      excludeComposed: true,
      excludeRunning: true,
    });
  });

  it("raises a refinement when the LLM returns action=refine", async () => {
    llmDecision({
      action: "refine",
      newPrompt: "Summarize, skipping newsletters.",
      rationale: "skip noise",
    });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeRefinement)).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: CHAT,
        newPrompt: "Summarize, skipping newsletters.",
        rationale: "skip noise",
      }),
    );
    expect(vi.mocked(proposeRetirement)).not.toHaveBeenCalled();
  });

  it("raises a retirement when the LLM returns action=retire", async () => {
    llmDecision({ action: "retire", rationale: "obsolete" });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeRetirement)).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, rationale: "obsolete" }),
    );
    expect(vi.mocked(proposeRefinement)).not.toHaveBeenCalled();
  });

  it("does nothing when the LLM returns action=none", async () => {
    llmDecision({ action: "none", rationale: "no clear fix" });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeRefinement)).not.toHaveBeenCalled();
    expect(vi.mocked(proposeRetirement)).not.toHaveBeenCalled();
  });

  it("skips a refine decision that omits newPrompt", async () => {
    llmDecision({ action: "refine", rationale: "no prompt given" });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeRefinement)).not.toHaveBeenCalled();
  });

  it("does not count a suppressed (anti-nag) proposal as raised", async () => {
    llmDecision({ action: "refine", newPrompt: "x", rationale: "y" });
    vi.mocked(proposeRefinement).mockResolvedValue({
      proposed: false,
      reason: "declined recently",
    });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeRefinement)).toHaveBeenCalledTimes(1);
  });

  it("skips a routine whose doc disappeared between health and review", async () => {
    vi.mocked(getRoutineById).mockResolvedValue(null);

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
  });

  it("stops reviewing once it raises a proposal (only one can be pending per chat)", async () => {
    vi.mocked(getRoutineHealth).mockResolvedValue([
      health({ routineId: "r1" }),
      health({ routineId: "r2" }),
      health({ routineId: "r3" }),
    ]);
    llmDecision({ action: "refine", newPrompt: "better", rationale: "fix" });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(1); // MAX_PROPOSALS_PER_RUN
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(1); // stops after the first raise
    expect(vi.mocked(proposeRefinement)).toHaveBeenCalledTimes(1);
  });

  it("caps paid LLM reviews per run even when every review returns action=none", async () => {
    vi.mocked(getRoutineHealth).mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => health({ routineId: `r${i}` })),
    );
    llmDecision({ action: "none", rationale: "no clear fix" });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(0);
    // MAX_REVIEWS_PER_RUN bounds spend — not all 10 flagged routines are reviewed.
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(6);
  });

  it("persists the LLM grade (chatId-scoped) for every reviewed routine", async () => {
    llmDecision({ grade: 55, action: "none", rationale: "fine-ish" });

    await reviewChatRoutines(CHAT, adapter);

    expect(vi.mocked(recordRoutineGrade)).toHaveBeenCalledWith("r1", CHAT, 55);
  });
});

describe("reviewChatRoutines — loop closure (post-refine regression)", () => {
  // A healthy routine (not flagged) becomes a candidate ONLY because it was
  // refined and has run enough times since — isolating the loop-closure path.
  beforeEach(() => {
    vi.mocked(getRoutineHealth).mockResolvedValue([health({ failedRuns: 0, totalRuns: 6 })]);
    vi.mocked(listRoutinesAwaitingPostRefineReview).mockResolvedValue(["r1"]);
  });

  it("offers a revert to the prior prompt+parameters when the grade regressed past the margin", async () => {
    const priorParameters = [
      { name: "topic", type: "string", description: "subject", required: false },
    ];
    vi.mocked(getRoutineById).mockResolvedValue(
      routine({
        preRefineGrade: 70,
        priorPrompt: "the previous prompt",
        priorParameters,
        lastRefinedAt: new Date(),
      }),
    );
    llmDecision({ grade: 40, action: "none", rationale: "graded post-refine" }); // 70→40, drop 30 ≥ 15

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeRefinement)).toHaveBeenCalledWith(
      expect.objectContaining({
        newPrompt: "the previous prompt",
        newParameters: priorParameters, // restores full prior state, not a hybrid
        trackForRegression: false,
      }),
    );
    // A regressed routine stays ARMED so the revert keeps being offered — it is
    // NOT graduated here (that would lose the baseline if the revert is ignored).
    expect(vi.mocked(clearRefineTracking)).not.toHaveBeenCalled();
  });

  it("when the revert is suppressed, falls through to the LLM's own refine (and stays armed)", async () => {
    vi.mocked(getRoutineById).mockResolvedValue(
      routine({
        preRefineGrade: 70,
        priorPrompt: "the previous prompt",
        lastRefinedAt: new Date(),
      }),
    );
    llmDecision({ grade: 40, action: "refine", newPrompt: "a fresh fix", rationale: "alt fix" });
    // First call (the revert) is anti-nag/one-pending suppressed; the fall-through
    // forward refine then succeeds.
    vi.mocked(proposeRefinement)
      .mockResolvedValueOnce({ proposed: false, reason: "declined recently" })
      .mockResolvedValueOnce({ proposed: true, confirmationId: "c9" });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(1);
    expect(vi.mocked(proposeRefinement)).toHaveBeenCalledTimes(2);
    // Second call is the LLM's forward refine, not another revert.
    expect(vi.mocked(proposeRefinement).mock.calls[1]?.[0]).toMatchObject({
      newPrompt: "a fresh fix",
    });
    // Still regressed → not graduated.
    expect(vi.mocked(clearRefineTracking)).not.toHaveBeenCalled();
  });

  it("does not revert (and graduates) when the refined routine held up", async () => {
    vi.mocked(getRoutineById).mockResolvedValue(
      routine({
        preRefineGrade: 70,
        priorPrompt: "the previous prompt",
        lastRefinedAt: new Date(),
      }),
    );
    llmDecision({ grade: 80, action: "none", rationale: "improved" }); // 70→80, no regression

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeRefinement)).not.toHaveBeenCalled();
    expect(vi.mocked(recordRoutineGrade)).toHaveBeenCalledWith("r1", CHAT, 80);
    expect(vi.mocked(clearRefineTracking)).toHaveBeenCalledWith("r1", CHAT);
  });

  it("does not revert without a pre-refine baseline (preRefineGrade null), still graduates", async () => {
    vi.mocked(getRoutineById).mockResolvedValue(
      routine({
        preRefineGrade: null,
        priorPrompt: "the previous prompt",
        lastRefinedAt: new Date(),
      }),
    );
    // Same low grade as the regression case — the ONLY thing preventing a revert
    // is the missing baseline, so this isolates the preRefineGrade !== null guard.
    llmDecision({ grade: 40, action: "none", rationale: "no baseline to compare" });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(proposeRefinement)).not.toHaveBeenCalled();
    expect(vi.mocked(clearRefineTracking)).toHaveBeenCalledWith("r1", CHAT);
  });
});
