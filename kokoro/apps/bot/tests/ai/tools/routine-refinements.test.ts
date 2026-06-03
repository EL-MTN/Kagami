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
  getRoutineById: vi.fn(),
  isRecentlyDeclined: vi.fn(),
  listPendingConfirmations: vi.fn(),
}));

vi.mock("../../../src/ai/tools/confirmations", () => ({
  raisePendingConfirmation: vi.fn(),
}));

import { getRoutineById, isRecentlyDeclined, listPendingConfirmations } from "@kokoro/db";
import { raisePendingConfirmation } from "../../../src/ai/tools/confirmations";
import {
  createProposeRoutineRefinementTool,
  computeRefinementSignature,
  computeRetirementSignature,
  proposeRetirement,
} from "../../../src/ai/tools/routine-refinements";

const adapter = fakeAdapter();
const CHAT = "chat-1";
const ROUTINE_ID = "444444444444444444444444";

function fakeRoutine(
  over: Partial<{ name: string; prompt: string; version: number; enabled: boolean }> = {},
) {
  return {
    _id: ROUTINE_ID,
    id: ROUTINE_ID,
    name: over.name ?? "morning-digest",
    prompt: over.prompt ?? "Fetch unread email and summarize.",
    parameters: [],
    version: over.version ?? 1,
    enabled: over.enabled ?? true,
  } as never;
}

const input = {
  routineId: ROUTINE_ID,
  newPrompt: "Fetch unread email, skip newsletters, and write a 3-bullet summary.",
  rationale: "It kept failing on empty inboxes — added a skip for newsletters.",
};

/** The ai SDK `tool()` wrapper stores the handler on `.execute`. */
function runTool(args: Record<string, unknown>) {
  const t = createProposeRoutineRefinementTool(CHAT, adapter) as unknown as {
    execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
  };
  return t.execute(args, {});
}

beforeEach(() => {
  vi.mocked(getRoutineById).mockResolvedValue(fakeRoutine());
  vi.mocked(isRecentlyDeclined).mockResolvedValue(false);
  vi.mocked(listPendingConfirmations).mockResolvedValue([]);
  vi.mocked(raisePendingConfirmation).mockResolvedValue("conf-1");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("computeRefinementSignature", () => {
  it("changes when the proposed prompt changes", () => {
    expect(computeRefinementSignature(ROUTINE_ID, 1, "a")).not.toBe(
      computeRefinementSignature(ROUTINE_ID, 1, "b"),
    );
  });

  it("changes when the base version changes (a landed edit invalidates old declines)", () => {
    expect(computeRefinementSignature(ROUTINE_ID, 1, "p")).not.toBe(
      computeRefinementSignature(ROUTINE_ID, 2, "p"),
    );
  });

  it("is stable for the same (routineId, version, prompt)", () => {
    expect(computeRefinementSignature(ROUTINE_ID, 1, "p")).toBe(
      computeRefinementSignature(ROUTINE_ID, 1, "p"),
    );
  });
});

describe("proposeRoutineRefinement — preconditions", () => {
  it("returns proposed:false when the routine does not exist", async () => {
    vi.mocked(getRoutineById).mockResolvedValue(null);
    const result = await runTool(input);
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("returns proposed:false when the routine is disabled", async () => {
    vi.mocked(getRoutineById).mockResolvedValue(fakeRoutine({ enabled: false }));
    const result = await runTool(input);
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("returns proposed:false when the new prompt is identical to the current one", async () => {
    vi.mocked(getRoutineById).mockResolvedValue(fakeRoutine({ prompt: "  same  " }));
    const result = await runTool({ ...input, newPrompt: "same" });
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });
});

describe("proposeRoutineRefinement — anti-nag guard", () => {
  it("suppresses (no bubble) when the signature was recently declined", async () => {
    vi.mocked(isRecentlyDeclined).mockResolvedValue(true);
    const result = await runTool(input);
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses when a refinement for THIS routine is already pending", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "updateRoutinePrompt", args: { routineId: ROUTINE_ID } } },
    ] as never);
    const result = await runTool(input);
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses when ANY routine proposal is pending, even for a different routine (one-at-a-time per chat)", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "updateRoutinePrompt", args: { routineId: "999999999999999999999999" } } },
    ] as never);
    const result = await runTool(input);
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("does NOT suppress when the only pending confirmation is a non-proposal action", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "sendEmail", args: {} } },
    ] as never);
    const result = await runTool(input);
    expect(result.proposed).toBe(true);
    expect(vi.mocked(raisePendingConfirmation)).toHaveBeenCalledTimes(1);
  });
});

describe("proposeRoutineRefinement — parameters", () => {
  it("allows a parameters-only refinement (prompt unchanged, parameters differ)", async () => {
    vi.mocked(getRoutineById).mockResolvedValue(fakeRoutine({ prompt: "Fetch and summarize." }));
    const result = await runTool({
      routineId: ROUTINE_ID,
      newPrompt: "Fetch and summarize.", // identical to current
      rationale: "tighten the date param",
      newParameters: [{ name: "date", type: "string", description: "the day", required: true }],
    });
    expect(result.proposed).toBe(true);
    const [, , raised] = vi.mocked(raisePendingConfirmation).mock.calls[0];
    expect(raised.action.args).toHaveProperty("newParameters");
  });

  it("the signature distinguishes two refinements with the same prompt but different parameters", () => {
    const a = computeRefinementSignature(ROUTINE_ID, 1, "p", [
      { name: "x", type: "string", description: "", required: true },
    ]);
    const b = computeRefinementSignature(ROUTINE_ID, 1, "p", [
      { name: "y", type: "string", description: "", required: true },
    ]);
    expect(a).not.toBe(b);
  });
});

describe("proposeRoutineRefinement — raising the bubble", () => {
  it("raises an updateRoutinePrompt confirmation carrying the signature, baseVersion, and before/after", async () => {
    vi.mocked(getRoutineById).mockResolvedValue(
      fakeRoutine({ prompt: "OLD PROMPT TEXT", version: 4 }),
    );

    const result = await runTool(input);

    expect(result.proposed).toBe(true);
    expect(result.confirmationId).toBe("conf-1");

    const [chatId, , raised] = vi.mocked(raisePendingConfirmation).mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect(raised.action.tool).toBe("updateRoutinePrompt");
    expect(raised.action.args.routineId).toBe(ROUTINE_ID);
    expect(raised.action.args.baseVersion).toBe(4);
    expect(raised.action.args.signature).toBe(
      computeRefinementSignature(ROUTINE_ID, 4, input.newPrompt),
    );
    expect(raised.origin).toBe("routine");
    expect(raised.ttlMs).toBeLessThan(24 * 60 * 60 * 1000);
    // The bubble shows both the current and proposed prompt for review.
    expect(raised.promptText).toContain("OLD PROMPT TEXT");
    expect(raised.promptText).toContain(input.newPrompt);
    expect(raised.promptText).toContain(input.rationale);
  });

  it("omits newParameters from the action args when not supplied", async () => {
    await runTool(input);
    const [, , raised] = vi.mocked(raisePendingConfirmation).mock.calls[0];
    expect(raised.action.args).not.toHaveProperty("newParameters");
  });

  it("returns proposed:false if raising the bubble throws", async () => {
    vi.mocked(raisePendingConfirmation).mockRejectedValue(new Error("adapter down"));
    const result = await runTool(input);
    expect(result.proposed).toBe(false);
    expect(result.reason).toBe("adapter down");
  });

  it("suppresses a refinement when a RETIREMENT for the same routine is already pending", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "disableRoutine", args: { routineId: ROUTINE_ID } } },
    ] as never);
    const result = await runTool(input);
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });
});

describe("computeRetirementSignature", () => {
  it("is version-scoped and stable", () => {
    expect(computeRetirementSignature(ROUTINE_ID, 1)).toBe(
      computeRetirementSignature(ROUTINE_ID, 1),
    );
    expect(computeRetirementSignature(ROUTINE_ID, 1)).not.toBe(
      computeRetirementSignature(ROUTINE_ID, 2),
    );
  });
});

describe("proposeRetirement", () => {
  function runRetire(
    over: Parameters<typeof fakeRoutine>[0] = {},
    rationale = "fundamentally broken",
  ) {
    return proposeRetirement({ chatId: CHAT, adapter, routine: fakeRoutine(over), rationale });
  }

  it("raises a disableRoutine confirmation carrying the signature and baseVersion", async () => {
    const result = await runRetire({ version: 3 });

    expect(result.proposed).toBe(true);
    expect(result.confirmationId).toBe("conf-1");

    const [chatId, , raised] = vi.mocked(raisePendingConfirmation).mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect(raised.action.tool).toBe("disableRoutine");
    expect(raised.action.args.routineId).toBe(ROUTINE_ID);
    expect(raised.action.args.baseVersion).toBe(3);
    expect(raised.action.args.signature).toBe(computeRetirementSignature(ROUTINE_ID, 3));
    expect(raised.origin).toBe("routine");
    expect(raised.promptText).toContain("fundamentally broken");
  });

  it("returns proposed:false when the routine is already disabled", async () => {
    const result = await runRetire({ enabled: false });
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses when the retirement was recently declined", async () => {
    vi.mocked(isRecentlyDeclined).mockResolvedValue(true);
    const result = await runRetire();
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses when a refinement for the same routine is already pending (cross-guard)", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "updateRoutinePrompt", args: { routineId: ROUTINE_ID } } },
    ] as never);
    const result = await runRetire();
    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });
});
