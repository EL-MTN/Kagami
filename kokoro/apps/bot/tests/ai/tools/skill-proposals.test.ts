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
import {
  computeSkillProposalSignature,
  createProposeSkillTool,
} from "../../../src/ai/tools/skills";

const adapter = fakeAdapter();
const CHAT = "chat-1";

const draft = {
  name: "meeting-followup-style",
  description: "Write followups after meetings",
  body: "Use concise bullets and a single next action.",
  triggers: ["after a meeting"],
  tags: ["writing"],
};

function runTool(input: Record<string, unknown>) {
  const t = createProposeSkillTool(CHAT, adapter) as unknown as {
    execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
  };
  return t.execute(input, {});
}

beforeEach(() => {
  vi.mocked(isSkillRecentlyDeclined).mockResolvedValue(false);
  vi.mocked(listPendingConfirmations).mockResolvedValue([]);
  vi.mocked(raisePendingConfirmation).mockResolvedValue("conf-1");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("computeSkillProposalSignature", () => {
  it("normalizes the name and changes when the body changes", () => {
    expect(computeSkillProposalSignature("  meeting   followup ", "p")).toBe(
      computeSkillProposalSignature("meeting followup", "p"),
    );
    expect(computeSkillProposalSignature("x", "a")).not.toBe(
      computeSkillProposalSignature("x", "b"),
    );
  });
});

describe("proposeSkill — guard", () => {
  it("suppresses when the signature was recently declined", async () => {
    vi.mocked(isSkillRecentlyDeclined).mockResolvedValue(true);

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

  it("suppresses when a routine proposal is already pending", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "updateRoutinePrompt", args: {} } },
    ] as never);

    const result = await runTool(draft);

    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });

  it("suppresses for a non-proposal pending confirmation (iMessage resolves YES/NO only with exactly one pending)", async () => {
    vi.mocked(listPendingConfirmations).mockResolvedValue([
      { action: { tool: "sendEmail", args: {} } },
    ] as never);

    const result = await runTool(draft);

    expect(result.proposed).toBe(false);
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
  });
});

describe("proposeSkill — raising the bubble", () => {
  it("raises a createSkill confirmation carrying the signature and full body", async () => {
    const result = await runTool(draft);

    expect(result.proposed).toBe(true);
    expect(result.confirmationId).toBe("conf-1");

    const [chatId, , input] = vi.mocked(raisePendingConfirmation).mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect(input.action.tool).toBe("createSkill");
    expect(input.action.args.signature).toBe(computeSkillProposalSignature(draft.name, draft.body));
    expect(input.action.args.name).toBe(draft.name);
    expect(input.action.args.triggers).toEqual(draft.triggers);
    expect(input.origin).toBe("conversation");
    expect(input.ttlMs).toBeLessThan(24 * 60 * 60 * 1000);
    expect(input.promptText).toContain(draft.body);
  });

  it("returns proposed:false if raising the bubble throws", async () => {
    vi.mocked(raisePendingConfirmation).mockRejectedValue(new Error("adapter down"));

    const result = await runTool(draft);

    expect(result.proposed).toBe(false);
    expect(result.reason).toBe("adapter down");
  });
});
