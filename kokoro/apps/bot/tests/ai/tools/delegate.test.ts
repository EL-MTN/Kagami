import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";

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

// The lean LLM core is the unit under the tool — stub it so these tests
// exercise fan-out orchestration (concurrency, ordering, error isolation, the
// child tool palette), not the model call itself.
const { mockRunTaskAgent } = vi.hoisted(() => ({ mockRunTaskAgent: vi.fn() }));
vi.mock("../../../src/services/task-agent", () => ({
  TASK_AGENT_TIMEOUT_MS: 180_000,
  runTaskAgent: mockRunTaskAgent,
}));

// Stub the provider so importing delegate doesn't construct the inference
// gateway, and token-tracker so a successful sub-task doesn't try to persist.
vi.mock("../../../src/ai/provider", () => ({
  ModelTier: { Default: "default", Fast: "fast", Smart: "smart" },
  getModel: () => ({}),
  getModelName: () => "claude-sonnet-4-6",
}));
const { mockTrackUsage } = vi.hoisted(() => ({ mockTrackUsage: vi.fn() }));
vi.mock("../../../src/ai/token-tracker", () => ({ trackUsage: mockTrackUsage }));

import { createDelegateTool } from "../../../src/ai/tools/delegate";
import type { ToolContext } from "../../../src/ai/tools/index";

interface ExecutableTool {
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  execute: (input: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>>;
}

type DelegateResult = { label: string; success: boolean; result?: string; error?: string };

function makeCtx(depth = 0): ToolContext {
  return {
    chatId: "chat-1",
    adapter: {} as ToolContext["adapter"],
    sessionId: "sess-1",
    routineDepth: depth,
  };
}

const noopBuilder = (_ctx?: ToolContext): ToolSet => ({});

beforeEach(() => {
  mockRunTaskAgent.mockReset();
  mockTrackUsage.mockReset();
});

describe("delegate tool — fan-out", () => {
  it("runs every sub-task and returns labelled results in input order", async () => {
    mockRunTaskAgent.mockImplementation(({ prompt }: { prompt: string }) => ({
      text: `result:${prompt}`,
      usage: { inputTokens: 1, outputTokens: 1 },
      steps: 1,
    }));
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    const res = await tool.execute({
      subtasks: [
        { label: "a", prompt: "task A" },
        { label: "b", prompt: "task B" },
      ],
    });

    expect(res.success).toBe(true);
    expect(res.results).toEqual([
      { label: "a", success: true, result: "result:task A" },
      { label: "b", success: true, result: "result:task B" },
    ]);
    expect(mockRunTaskAgent).toHaveBeenCalledTimes(2);
    expect(mockTrackUsage).toHaveBeenCalledTimes(2);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      "delegate",
      "claude-sonnet-4-6",
      expect.anything(),
      expect.objectContaining({ chatId: "chat-1" }),
    );
  });

  it("builds the sub-task palette once with depth + 1", async () => {
    mockRunTaskAgent.mockResolvedValue({ text: "x", usage: {}, steps: 1 });
    const builder = vi.fn(noopBuilder);
    const tool = createDelegateTool(makeCtx(1), builder) as unknown as ExecutableTool;

    await tool.execute({
      subtasks: [
        { label: "a", prompt: "A" },
        { label: "b", prompt: "B" },
      ],
    });

    expect(builder).toHaveBeenCalledTimes(1);
    expect(builder).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1", routineDepth: 2 }),
    );
  });

  it("isolates a failing sub-task — siblings still succeed", async () => {
    mockRunTaskAgent.mockImplementation(({ prompt }: { prompt: string }) => {
      if (prompt === "boom") throw new Error("LLM 500");
      return { text: "ok", usage: {}, steps: 1 };
    });
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    const res = await tool.execute({
      subtasks: [
        { label: "good", prompt: "fine" },
        { label: "bad", prompt: "boom" },
      ],
    });

    expect(res.results).toEqual([
      { label: "good", success: true, result: "ok" },
      { label: "bad", success: false, error: "LLM 500" },
    ]);
    // Only the successful branch records usage.
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
  });

  it("caps concurrency at 4 in-flight sub-tasks", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockRunTaskAgent.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { text: "ok", usage: {}, steps: 1 };
    });
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    await tool.execute({
      subtasks: Array.from({ length: 6 }, (_, i) => ({ label: `s${i}`, prompt: `p${i}` })),
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(mockRunTaskAgent).toHaveBeenCalledTimes(6);
  });

  it("preserves input order even when later branches finish first", async () => {
    mockRunTaskAgent.mockImplementation(async ({ prompt }: { prompt: string }) => {
      await new Promise((r) => setTimeout(r, prompt === "slow" ? 20 : 1));
      return { text: `done:${prompt}`, usage: {}, steps: 1 };
    });
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    const res = await tool.execute({
      subtasks: [
        { label: "first", prompt: "slow" },
        { label: "second", prompt: "fast" },
      ],
    });

    expect((res.results as DelegateResult[]).map((r) => r.label)).toEqual(["first", "second"]);
  });
});

describe("delegate tool — input bounds", () => {
  const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

  it("requires at least 2 sub-tasks", () => {
    expect(tool.inputSchema.safeParse({ subtasks: [{ label: "a", prompt: "A" }] }).success).toBe(
      false,
    );
  });

  it("rejects more than 6 sub-tasks", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ label: `s${i}`, prompt: "p" }));
    expect(tool.inputSchema.safeParse({ subtasks: seven }).success).toBe(false);
  });

  it("accepts 2 well-formed sub-tasks", () => {
    expect(
      tool.inputSchema.safeParse({
        subtasks: [
          { label: "a", prompt: "A" },
          { label: "b", prompt: "B" },
        ],
      }).success,
    ).toBe(true);
  });
});
