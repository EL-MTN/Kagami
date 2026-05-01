import { fakeAdapter, withTestDb } from "@mashiro/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mashiro/shared", async (orig) => ({
  ...((await orig()) as object),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const { mockExecuteRoutine } = vi.hoisted(() => ({ mockExecuteRoutine: vi.fn() }));
vi.mock("../../../src/services/routine-executor", () => ({
  // MAX_ROUTINE_DEPTH is the recursion bound — the tool reads it directly.
  MAX_ROUTINE_DEPTH: 3,
  executeRoutine: mockExecuteRoutine,
}));

import { createRoutine, Routine } from "@mashiro/db";
import { createUseRoutineTool } from "../../../src/ai/tools/use-routine";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const adapter = fakeAdapter();

beforeEach(() => {
  mockExecuteRoutine.mockReset();
});

async function seedRoutine(
  name: string,
  options: {
    purity?: "read" | "action";
    enabled?: boolean;
    parameters?: Array<{
      name: string;
      type: "string" | "number" | "boolean" | "array" | "object";
      description: string;
      required: boolean;
      default?: unknown;
    }>;
  } = {},
) {
  return createRoutine("chat-1", {
    name,
    description: "x",
    prompt: "y",
    reportMode: "always",
    purity: options.purity ?? "action",
    enabled: options.enabled ?? true,
    parameters: options.parameters ?? [],
  });
}

describe("useRoutine tool — invocation", () => {
  it("delegates to executeRoutine on the happy path", async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedRoutine("greet");
    mockExecuteRoutine.mockResolvedValue("hello world");

    const result = await tool.execute({ routineName: "greet" });

    expect(result).toEqual({ success: true, routineName: "greet", result: "hello world" });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(
      expect.objectContaining({
        trigger: "routine",
        depth: 1,
        callingContext: "main",
      }),
    );
  });

  it("returns an error when the routine doesn't exist", async () => {
    const tool = createUseRoutineTool("chat-1", adapter) as unknown as ExecutableTool;
    const result = await tool.execute({ routineName: "missing" });
    expect(result).toEqual({ success: false, reason: 'Routine "missing" not found' });
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
  });

  it("rejects disabled routines", async () => {
    const tool = createUseRoutineTool("chat-1", adapter) as unknown as ExecutableTool;
    const routine = await seedRoutine("off");
    await Routine.findByIdAndUpdate(routine._id, { enabled: false });
    const result = await tool.execute({ routineName: "off" });
    expect(result).toEqual({ success: false, reason: 'Routine "off" is disabled' });
  });

  it("returns an error past MAX_ROUTINE_DEPTH", async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      3, // == MAX_ROUTINE_DEPTH
      "main",
    ) as unknown as ExecutableTool;
    const result = await tool.execute({ routineName: "anything" });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/Maximum routine depth/);
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
  });

  it("propagates depth + 1 to executeRoutine on a deeper hop", async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      1,
      "main",
    ) as unknown as ExecutableTool;
    await seedRoutine("deeper");
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "deeper" });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ depth: 2, callingContext: "main" }));
  });

  it("forwards executor errors as a failed result", async () => {
    const tool = createUseRoutineTool("chat-1", adapter) as unknown as ExecutableTool;
    await seedRoutine("fail");
    mockExecuteRoutine.mockRejectedValue(new Error("LLM 500"));
    const result = await tool.execute({ routineName: "fail" });
    expect(result).toEqual({ success: false, reason: "LLM 500" });
  });
});

describe("useRoutine tool — purity gate (watcher context)", () => {
  it('rejects an action-purity routine when callingContext="watcher"', async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "watcher",
    ) as unknown as ExecutableTool;
    await seedRoutine("act", { purity: "action" });
    const result = await tool.execute({ routineName: "act" });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/has purity "action"/);
    expect(result.reason as string).toMatch(/cannot be invoked from a watcher/);
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
  });

  it('allows a read-purity routine from a watcher and propagates callingContext="watcher"', async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "watcher",
    ) as unknown as ExecutableTool;
    await seedRoutine("read-only", { purity: "read" });
    mockExecuteRoutine.mockResolvedValue("watched");
    const result = await tool.execute({ routineName: "read-only" });
    expect(result).toEqual({
      success: true,
      routineName: "read-only",
      result: "watched",
    });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ callingContext: "watcher" }));
  });
});

describe("useRoutine tool — parameter validation", () => {
  it("returns the first parameter error message", async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedRoutine("typed", {
      parameters: [
        { name: "topic", type: "string", description: "what", required: true },
      ],
    });
    const result = await tool.execute({ routineName: "typed", parameters: {} });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/Parameter "topic"/);
  });

  it("coerces inputs through the param schema before executing", async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedRoutine("nums", {
      parameters: [{ name: "n", type: "number", description: "x", required: true }],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "nums", parameters: { n: "42" } });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { n: 42 } }));
  });

  it("stringifies numbers passed for string-typed params (LLM tolerance)", async () => {
    // LLMs occasionally return `42` for a string-typed field; the original
    // hand-rolled validator stringified them. Pin that behavior.
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedRoutine("topic", {
      parameters: [{ name: "topic", type: "string", description: "x", required: true }],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "topic", parameters: { topic: 42 } });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { topic: "42" } }));
  });

  it("stringifies booleans passed for string-typed params (LLM tolerance)", async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedRoutine("flag", {
      parameters: [{ name: "flag", type: "string", description: "x", required: true }],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "flag", parameters: { flag: true } });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { flag: "true" } }));
  });

  it("applies defaults from the routine parameters", async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedRoutine("withdef", {
      parameters: [
        {
          name: "topic",
          type: "string",
          description: "x",
          required: true,
          default: "news",
        },
      ],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "withdef", parameters: {} });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { topic: "news" } }));
  });

  it("coerces a non-string default to string for a string-typed param", async () => {
    // Default values stored on a Routine are typed as Mixed in Mongoose, so an
    // LLM can land a number default on a string-typed param. The default must
    // flow through the same coercion as a present value — otherwise the routine
    // executor receives a number where a string is contracted.
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedRoutine("numdef", {
      parameters: [
        {
          name: "topic",
          type: "string",
          description: "x",
          required: true,
          default: 42,
        },
      ],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "numdef", parameters: {} });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { topic: "42" } }));
  });

  it("coerces a string default to number for a number-typed param", async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedRoutine("strdef", {
      parameters: [
        {
          name: "limit",
          type: "number",
          description: "x",
          required: true,
          default: "10",
        },
      ],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "strdef", parameters: {} });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { limit: 10 } }));
  });
});
