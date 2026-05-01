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

const { mockExecuteSkill } = vi.hoisted(() => ({ mockExecuteSkill: vi.fn() }));
vi.mock("../../../src/services/skill-executor", () => ({
  // MAX_SKILL_DEPTH is the recursion bound — the tool reads it directly.
  MAX_SKILL_DEPTH: 3,
  executeSkill: mockExecuteSkill,
}));

import { createSkill, Skill } from "@mashiro/db";
import { createUseSkillTool } from "../../../src/ai/tools/use-skill";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const adapter = fakeAdapter();

beforeEach(() => {
  mockExecuteSkill.mockReset();
});

async function seedSkill(
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
  return createSkill("chat-1", {
    name,
    description: "x",
    prompt: "y",
    reportMode: "always",
    purity: options.purity ?? "action",
    enabled: options.enabled ?? true,
    parameters: options.parameters ?? [],
  });
}

describe("useSkill tool — invocation", () => {
  it("delegates to executeSkill on the happy path", async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedSkill("greet");
    mockExecuteSkill.mockResolvedValue("hello world");

    const result = await tool.execute({ skillName: "greet" });

    expect(result).toEqual({ success: true, skillName: "greet", result: "hello world" });
    const call = mockExecuteSkill.mock.calls[0]!;
    expect(call[2]).toEqual(
      expect.objectContaining({
        trigger: "skill",
        depth: 1,
        callingContext: "main",
      }),
    );
  });

  it("returns an error when the skill doesn't exist", async () => {
    const tool = createUseSkillTool("chat-1", adapter) as unknown as ExecutableTool;
    const result = await tool.execute({ skillName: "missing" });
    expect(result).toEqual({ success: false, reason: 'Skill "missing" not found' });
    expect(mockExecuteSkill).not.toHaveBeenCalled();
  });

  it("rejects disabled skills", async () => {
    const tool = createUseSkillTool("chat-1", adapter) as unknown as ExecutableTool;
    const skill = await seedSkill("off");
    await Skill.findByIdAndUpdate(skill._id, { enabled: false });
    const result = await tool.execute({ skillName: "off" });
    expect(result).toEqual({ success: false, reason: 'Skill "off" is disabled' });
  });

  it("returns an error past MAX_SKILL_DEPTH", async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      3, // == MAX_SKILL_DEPTH
      "main",
    ) as unknown as ExecutableTool;
    const result = await tool.execute({ skillName: "anything" });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/Maximum skill depth/);
    expect(mockExecuteSkill).not.toHaveBeenCalled();
  });

  it("propagates depth + 1 to executeSkill on a deeper hop", async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      1,
      "main",
    ) as unknown as ExecutableTool;
    await seedSkill("deeper");
    mockExecuteSkill.mockResolvedValue("ok");
    await tool.execute({ skillName: "deeper" });
    const call = mockExecuteSkill.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ depth: 2, callingContext: "main" }));
  });

  it("forwards executor errors as a failed result", async () => {
    const tool = createUseSkillTool("chat-1", adapter) as unknown as ExecutableTool;
    await seedSkill("fail");
    mockExecuteSkill.mockRejectedValue(new Error("LLM 500"));
    const result = await tool.execute({ skillName: "fail" });
    expect(result).toEqual({ success: false, reason: "LLM 500" });
  });
});

describe("useSkill tool — purity gate (watcher context)", () => {
  it('rejects an action-purity skill when callingContext="watcher"', async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "watcher",
    ) as unknown as ExecutableTool;
    await seedSkill("act", { purity: "action" });
    const result = await tool.execute({ skillName: "act" });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/has purity "action"/);
    expect(result.reason as string).toMatch(/cannot be invoked from a watcher/);
    expect(mockExecuteSkill).not.toHaveBeenCalled();
  });

  it('allows a read-purity skill from a watcher and propagates callingContext="watcher"', async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "watcher",
    ) as unknown as ExecutableTool;
    await seedSkill("read-only", { purity: "read" });
    mockExecuteSkill.mockResolvedValue("watched");
    const result = await tool.execute({ skillName: "read-only" });
    expect(result).toEqual({
      success: true,
      skillName: "read-only",
      result: "watched",
    });
    const call = mockExecuteSkill.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ callingContext: "watcher" }));
  });
});

describe("useSkill tool — parameter validation", () => {
  it("returns the first parameter error message", async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedSkill("typed", {
      parameters: [
        { name: "topic", type: "string", description: "what", required: true },
      ],
    });
    const result = await tool.execute({ skillName: "typed", parameters: {} });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/Parameter "topic"/);
  });

  it("coerces inputs through the param schema before executing", async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedSkill("nums", {
      parameters: [{ name: "n", type: "number", description: "x", required: true }],
    });
    mockExecuteSkill.mockResolvedValue("ok");
    await tool.execute({ skillName: "nums", parameters: { n: "42" } });
    const call = mockExecuteSkill.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { n: 42 } }));
  });

  it("stringifies numbers passed for string-typed params (LLM tolerance)", async () => {
    // LLMs occasionally return `42` for a string-typed field; the original
    // hand-rolled validator stringified them. Pin that behavior.
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedSkill("topic", {
      parameters: [{ name: "topic", type: "string", description: "x", required: true }],
    });
    mockExecuteSkill.mockResolvedValue("ok");
    await tool.execute({ skillName: "topic", parameters: { topic: 42 } });
    const call = mockExecuteSkill.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { topic: "42" } }));
  });

  it("stringifies booleans passed for string-typed params (LLM tolerance)", async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedSkill("flag", {
      parameters: [{ name: "flag", type: "string", description: "x", required: true }],
    });
    mockExecuteSkill.mockResolvedValue("ok");
    await tool.execute({ skillName: "flag", parameters: { flag: true } });
    const call = mockExecuteSkill.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { flag: "true" } }));
  });

  it("applies defaults from the skill parameters", async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedSkill("withdef", {
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
    mockExecuteSkill.mockResolvedValue("ok");
    await tool.execute({ skillName: "withdef", parameters: {} });
    const call = mockExecuteSkill.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { topic: "news" } }));
  });

  it("coerces a non-string default to string for a string-typed param", async () => {
    // Default values stored on a Skill are typed as Mixed in Mongoose, so an
    // LLM can land a number default on a string-typed param. The default must
    // flow through the same coercion as a present value — otherwise the skill
    // executor receives a number where a string is contracted.
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedSkill("numdef", {
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
    mockExecuteSkill.mockResolvedValue("ok");
    await tool.execute({ skillName: "numdef", parameters: {} });
    const call = mockExecuteSkill.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { topic: "42" } }));
  });

  it("coerces a string default to number for a number-typed param", async () => {
    const tool = createUseSkillTool(
      "chat-1",
      adapter,
      0,
      "main",
    ) as unknown as ExecutableTool;
    await seedSkill("strdef", {
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
    mockExecuteSkill.mockResolvedValue("ok");
    await tool.execute({ skillName: "strdef", parameters: {} });
    const call = mockExecuteSkill.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { limit: 10 } }));
  });
});
