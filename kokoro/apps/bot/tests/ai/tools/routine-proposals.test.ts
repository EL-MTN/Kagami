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
  isRecentlyDeclined: vi.fn(),
  listPendingConfirmations: vi.fn(),
}));

vi.mock("../../../src/ai/tools/confirmations", () => ({
  raisePendingConfirmation: vi.fn(),
}));

import { isRecentlyDeclined, listPendingConfirmations } from "@kokoro/db";
import { raisePendingConfirmation } from "../../../src/ai/tools/confirmations";
import {
  createProposeRoutineTool,
  computeProposalSignature,
} from "../../../src/ai/tools/routine-proposals";

const adapter = fakeAdapter();
const CHAT = "chat-1";

const draft = {
  name: "Morning Digest",
  description: "Summarize unread email each morning",
  prompt: "Fetch unread email and write a 3-bullet summary.",
};

/** The ai SDK `tool()` wrapper stores the handler on `.execute`. */
function runTool(input: Record<string, unknown>) {
  const t = createProposeRoutineTool(CHAT, adapter) as unknown as {
    execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
  };
  return t.execute(input, {});
}

beforeEach(() => {
  vi.mocked(isRecentlyDeclined).mockResolvedValue(false);
  vi.mocked(listPendingConfirmations).mockResolvedValue([]);
  vi.mocked(raisePendingConfirmation).mockResolvedValue("conf-1");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("computeProposalSignature", () => {
  it("normalizes the name (case/whitespace) and is stable for the same prompt", () => {
    expect(computeProposalSignature("  Morning   Digest ", "p")).toBe(
      computeProposalSignature("morning digest", "p"),
    );
  });

  it("changes when the prompt changes", () => {
    expect(computeProposalSignature("x", "a")).not.toBe(computeProposalSignature("x", "b"));
  });
});

describe("proposeRoutine — guard", () => {
  it("suppresses (no bubble) when the signature was recently declined", async () => {
    vi.mocked(isRecentlyDeclined).mockResolvedValue(true);

    const result = await runTool(draft);

    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses when a routine proposal is already pending", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "createRoutine", args: {} } },
    ] as never);

    const result = await runTool(draft);

    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses when a skill proposal is already pending", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "createSkill", args: {} } },
    ] as never);

    const result = await runTool(draft);

    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses when a NON-proposal confirmation is pending (iMessage resolves YES/NO only with exactly one pending)", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "sendEmail", args: {} } },
    ] as never);

    const result = await runTool(draft);

    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });
});

describe("proposeRoutine — raising the bubble", () => {
  it("raises a createRoutine confirmation carrying the signature + draft, with a short TTL and full-prompt text", async () => {
    const result = await runTool(draft);

    expect(result.proposed).toBe(true);
    expect(result.confirmationId).toBe("conf-1");

    const [chatId, , input] = vi.mocked(raisePendingConfirmation).mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect(input.action.tool).toBe("createRoutine");
    expect(input.action.args.signature).toBe(computeProposalSignature(draft.name, draft.prompt));
    expect(input.action.args.name).toBe(draft.name);
    expect(input.origin).toBe("routine");
    // Shorter than the 24h action-confirmation TTL.
    expect(input.ttlMs).toBeLessThan(24 * 60 * 60 * 1000);
    // The bubble shows the full routine prompt for review.
    expect(input.promptText).toContain(draft.prompt);
  });

  it("returns proposed:false if raising the bubble throws", async () => {
    vi.mocked(raisePendingConfirmation).mockRejectedValue(new Error("adapter down"));
    const result = await runTool(draft);
    expect(result.proposed).toBe(false);
    expect(result.reason).toBe("adapter down");
  });
});
