import { fakeAdapter } from "@kokoro/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

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

vi.mock("../../../src/ai/tools/confirmations", () => ({
  raisePendingConfirmation: vi.fn(),
}));

import { raisePendingConfirmation } from "../../../src/ai/tools/confirmations";
import { createExecuteCodeTool } from "../../../src/ai/tools/execute-code";

const adapter = fakeAdapter();
const CHAT = "chat-1";

/** The ai SDK `tool()` wrapper stores the handler on `.execute`. */
function makeTool() {
  return createExecuteCodeTool(CHAT, adapter) as unknown as {
    inputSchema: z.ZodTypeAny;
    execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
  };
}

function runTool(input: Record<string, unknown>) {
  return makeTool().execute(input, {});
}

beforeEach(() => {
  vi.mocked(raisePendingConfirmation).mockResolvedValue("conf-1");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("executeCode — input schema", () => {
  it("rejects empty code, oversize code, and unknown languages", () => {
    const schema = makeTool().inputSchema;
    expect(schema.safeParse({ language: "python", code: "", description: "d" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ language: "python", code: "x".repeat(8001), description: "d" }).success,
    ).toBe(false);
    expect(schema.safeParse({ language: "ruby", code: "puts 1", description: "d" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ language: "python", code: "print(1)", description: "" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ language: "node", code: "console.log(1)", description: "log one" })
        .success,
    ).toBe(true);
  });
});

describe("executeCode — raises the confirmation, never executes directly", () => {
  it("raises a confirmation targeting the dispatch-only executeCode action with the exact args", async () => {
    const result = await runTool({
      language: "python",
      code: "print(40 + 2)",
      description: "compute the answer",
    });

    expect(result.pending).toBe(true);
    expect(result.confirmationId).toBe("conf-1");

    expect(vi.mocked(raisePendingConfirmation)).toHaveBeenCalledTimes(1);
    const [chatId, , input] = vi.mocked(raisePendingConfirmation).mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect(input.summary).toBe("run python code: compute the answer");
    // The action carries language + code only — `description` is bubble text.
    expect(input.action).toEqual({
      tool: "executeCode",
      args: { language: "python", code: "print(40 + 2)" },
    });
  });

  it("shows the full code as a fenced block in promptText (the user reviews the program, not a summary)", async () => {
    await runTool({
      language: "python",
      code: "print(40 + 2)",
      description: "compute the answer",
    });

    const input = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(input.promptText).toContain("compute the answer");
    expect(input.promptText).toContain("```python\nprint(40 + 2)\n```");
  });

  it("uses a js fence tag for node code", async () => {
    await runTool({ language: "node", code: "console.log(1)", description: "log one" });

    const input = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(input.promptText).toContain("```js\nconsole.log(1)\n```");
  });

  it("truncates the bubble preview past 3000 chars with an explicit marker (full code still in action.args)", async () => {
    const code = "x".repeat(4000);
    await runTool({ language: "python", code, description: "long script" });

    const input = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(input.promptText).toContain(`${"x".repeat(3000)}\n… (1000 more chars)`);
    expect(input.promptText).not.toContain("x".repeat(3001));
    // The action args carry the FULL code — only the preview is truncated.
    expect((input.action.args as { code: string }).code).toBe(code);
  });

  it("returns a non-pending error result when raising the confirmation fails", async () => {
    vi.mocked(raisePendingConfirmation).mockRejectedValue(new Error("mongo down"));

    const result = await runTool({
      language: "python",
      code: "print(1)",
      description: "compute",
    });

    expect(result.pending).toBe(false);
    expect(result.success).toBe(false);
    expect(result.reason).toBe("mongo down");
  });
});
