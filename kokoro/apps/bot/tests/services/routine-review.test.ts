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
import { getRoutineHealth, getRoutineById, getRoutineLogs } from "@kokoro/db";
import { proposeRefinement, proposeRetirement } from "../../src/ai/tools/routine-refinements";
import { needsReview, reviewChatRoutines } from "../../src/services/routine-review";

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
    object,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  } as never);
}

beforeEach(() => {
  vi.mocked(getRoutineHealth).mockResolvedValue([health()]);
  vi.mocked(getRoutineById).mockImplementation((id: string) => Promise.resolve(routine({ id })));
  vi.mocked(getRoutineLogs).mockResolvedValue([]);
  llmDecision({ action: "none", rationale: "looks fine" });
  vi.mocked(proposeRefinement).mockResolvedValue({ proposed: true, confirmationId: "c1" });
  vi.mocked(proposeRetirement).mockResolvedValue({ proposed: true, confirmationId: "c2" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("needsReview", () => {
  it("is false below the minimum run count", () => {
    expect(needsReview(health({ totalRuns: 3, failedRuns: 3 }))).toBe(false);
  });

  it("is true when the bad rate meets the threshold", () => {
    expect(needsReview(health({ totalRuns: 6, failedRuns: 3, emptyRuns: 0 }))).toBe(true);
  });

  it("is false when the bad rate is below the threshold", () => {
    expect(needsReview(health({ totalRuns: 6, failedRuns: 1, emptyRuns: 1 }))).toBe(false);
  });

  it("counts empty runs alongside failures, ignores no-report", () => {
    expect(
      needsReview(health({ totalRuns: 6, failedRuns: 1, emptyRuns: 2, noReportRuns: 3 })),
    ).toBe(true);
  });
});

describe("reviewChatRoutines", () => {
  it("does not call the LLM when no routine is unhealthy enough", async () => {
    vi.mocked(getRoutineHealth).mockResolvedValue([health({ failedRuns: 1, totalRuns: 6 })]);

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(0);
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    expect(vi.mocked(proposeRefinement)).not.toHaveBeenCalled();
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

  it("caps proposals per run and stops reviewing once the cap is hit", async () => {
    vi.mocked(getRoutineHealth).mockResolvedValue([
      health({ routineId: "r1" }),
      health({ routineId: "r2" }),
      health({ routineId: "r3" }),
    ]);
    llmDecision({ action: "refine", newPrompt: "better", rationale: "fix" });

    const raised = await reviewChatRoutines(CHAT, adapter);

    expect(raised).toBe(2); // MAX_PROPOSALS_PER_RUN
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(2); // 3rd routine never reviewed
    expect(vi.mocked(proposeRefinement)).toHaveBeenCalledTimes(2);
  });
});
