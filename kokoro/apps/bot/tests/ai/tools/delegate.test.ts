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

// Routine-backed branches: stub the executor (the routine-run path) and the
// DB lookup so these tests stay DB-free and focus on delegate's gate +
// dispatch. validateParameters (the routine-params leaf) runs for real.
const { mockExecuteRoutine } = vi.hoisted(() => ({ mockExecuteRoutine: vi.fn() }));
vi.mock("../../../src/services/routine-executor", () => ({
  MAX_ROUTINE_DEPTH: 3,
  executeRoutine: mockExecuteRoutine,
}));
const { mockGetRoutineByName } = vi.hoisted(() => ({ mockGetRoutineByName: vi.fn() }));
vi.mock("@kokoro/db", () => ({ getRoutineByName: mockGetRoutineByName }));

import { createDelegateTool } from "../../../src/ai/tools/delegate";
import type { ToolContext } from "../../../src/ai/tools/index";

interface SeedRoutine {
  name: string;
  enabled: boolean;
  purity: "read" | "action";
  parameters: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "array" | "object";
    description: string;
    required: boolean;
    default?: unknown;
  }>;
}

function seedRoutine(overrides: Partial<SeedRoutine> = {}): SeedRoutine {
  return {
    name: overrides.name ?? "gather",
    enabled: overrides.enabled ?? true,
    purity: overrides.purity ?? "read",
    parameters: overrides.parameters ?? [],
  };
}

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
  mockExecuteRoutine.mockReset();
  mockGetRoutineByName.mockReset();
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

    // Exactly 4 — proves both the cap (not >4) and real parallelism (a serial
    // implementation would peak at 1).
    expect(maxInFlight).toBe(4);
    expect(mockRunTaskAgent).toHaveBeenCalledTimes(6);
  });

  it("reports an inline sub-task with empty text as a success with empty result", async () => {
    mockRunTaskAgent.mockResolvedValue({ text: "", usage: {}, steps: 1 });
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    const res = await tool.execute({
      subtasks: [
        { label: "a", prompt: "A" },
        { label: "b", prompt: "B" },
      ],
    });

    expect(res.results).toEqual([
      { label: "a", success: true, result: "" },
      { label: "b", success: true, result: "" },
    ]);
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

describe("delegate tool — routine-backed branches", () => {
  it("runs a read-purity routine via executeRoutine (trigger routine, watcher, depth+1)", async () => {
    mockGetRoutineByName.mockResolvedValue(seedRoutine({ name: "gather-news" }));
    mockExecuteRoutine.mockResolvedValue("the news");
    mockRunTaskAgent.mockReturnValue({ text: "sunny", usage: {}, steps: 1 });
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    const res = await tool.execute({
      subtasks: [
        { label: "news", routineName: "gather-news" },
        { label: "weather", prompt: "forecast" },
      ],
    });

    expect((res.results as DelegateResult[])[0]).toEqual({
      label: "news",
      success: true,
      result: "the news",
    });
    expect(mockExecuteRoutine).toHaveBeenCalledTimes(1);
    const call = mockExecuteRoutine.mock.calls[0];
    expect(call[2]).toEqual(
      expect.objectContaining({ trigger: "routine", callingContext: "watcher", depth: 1 }),
    );
  });

  it("rejects an action-purity routine — never executes it", async () => {
    mockGetRoutineByName.mockResolvedValue(seedRoutine({ name: "send-it", purity: "action" }));
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    const res = await tool.execute({
      subtasks: [
        { label: "x", routineName: "send-it" },
        { label: "y", routineName: "send-it" },
      ],
    });

    const results = res.results as DelegateResult[];
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/purity "action"/);
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
  });

  it("fails a branch when the routine is missing or disabled", async () => {
    mockGetRoutineByName.mockImplementation((_chatId: string, name: string) =>
      name === "off" ? seedRoutine({ name: "off", enabled: false }) : null,
    );
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    const res = await tool.execute({
      subtasks: [
        { label: "missing", routineName: "ghost" },
        { label: "disabled", routineName: "off" },
      ],
    });

    const results = res.results as DelegateResult[];
    expect(results[0]).toEqual({
      label: "missing",
      success: false,
      error: 'Routine "ghost" not found',
    });
    expect(results[1].error).toMatch(/is disabled/);
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
  });

  it("validates + coerces routine parameters before executing", async () => {
    mockGetRoutineByName.mockResolvedValue(
      seedRoutine({
        name: "lookup",
        parameters: [{ name: "limit", type: "number", description: "n", required: true }],
      }),
    );
    mockExecuteRoutine.mockResolvedValue("done");
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    // valid: "5" coerces to number 5
    await tool.execute({
      subtasks: [
        { label: "ok", routineName: "lookup", parameters: { limit: "5" } },
        { label: "bad", routineName: "lookup", parameters: {} },
      ],
    });

    const okCall = mockExecuteRoutine.mock.calls[0];
    expect(okCall[2]).toEqual(expect.objectContaining({ parameters: { limit: 5 } }));
    // the missing-required-param branch never reaches the executor
    expect(mockExecuteRoutine).toHaveBeenCalledTimes(1);
  });

  it("links a routine-backed branch to the parent run via parentLogId", async () => {
    mockGetRoutineByName.mockResolvedValue(seedRoutine({ name: "gather" }));
    mockExecuteRoutine.mockResolvedValue("ok");
    const ctx: ToolContext = { ...makeCtx(1), routineLogId: "parent-log-123" };
    const tool = createDelegateTool(ctx, noopBuilder) as unknown as ExecutableTool;

    await tool.execute({
      subtasks: [
        { label: "a", routineName: "gather" },
        { label: "b", routineName: "gather" },
      ],
    });

    const call = mockExecuteRoutine.mock.calls[0];
    expect(call[2]).toEqual(
      expect.objectContaining({
        parentLogId: "parent-log-123",
        depth: 2,
        trigger: "routine",
        // rethrow → a failed routine run surfaces as a failed branch, not an
        // "Error: …" string masquerading as success.
        rethrow: true,
      }),
    );
  });

  it("reports a routine-backed branch as failed when executeRoutine throws", async () => {
    mockGetRoutineByName.mockResolvedValue(seedRoutine({ name: "gather" }));
    mockExecuteRoutine.mockRejectedValue(new Error("routine blew up"));
    const tool = createDelegateTool(makeCtx(0), noopBuilder) as unknown as ExecutableTool;

    const res = await tool.execute({
      subtasks: [
        { label: "a", routineName: "gather" },
        { label: "b", routineName: "gather" },
      ],
    });

    expect(res.results).toEqual([
      { label: "a", success: false, error: "routine blew up" },
      { label: "b", success: false, error: "routine blew up" },
    ]);
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

  it("requires exactly one of prompt or routineName per sub-task", () => {
    // neither
    expect(
      tool.inputSchema.safeParse({
        subtasks: [{ label: "a" }, { label: "b", prompt: "B" }],
      }).success,
    ).toBe(false);
    // both
    expect(
      tool.inputSchema.safeParse({
        subtasks: [
          { label: "a", prompt: "A", routineName: "r" },
          { label: "b", prompt: "B" },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a mix of inline-prompt and routine-backed sub-tasks", () => {
    expect(
      tool.inputSchema.safeParse({
        subtasks: [
          { label: "a", prompt: "A" },
          { label: "b", routineName: "gather", parameters: { x: 1 } },
        ],
      }).success,
    ).toBe(true);
  });
});
