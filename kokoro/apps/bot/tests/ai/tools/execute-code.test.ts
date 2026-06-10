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
    // 3000 = MAX_CODE_LENGTH: the cap that guarantees the approval bubble
    // shows the complete program (nothing executable can hide past a preview).
    expect(
      schema.safeParse({ language: "python", code: "x".repeat(3001), description: "d" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ language: "python", code: "x".repeat(3000), description: "d" }).success,
    ).toBe(true);
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

  it("shows a max-length program in full — the bubble is never a truncated preview", async () => {
    // The schema cap (3000) exists precisely so promptText always carries the
    // ENTIRE program: an approval must never run code the user couldn't see.
    const code = "x".repeat(3000);
    await runTool({ language: "python", code, description: "long script" });

    const input = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(input.promptText).toContain(`\`\`\`python\n${code}\n\`\`\``);
    expect((input.action.args as { code: string }).code).toBe(code);
  });

  it("lengthens the fence when the code itself contains triple backticks", async () => {
    // An embedded ``` must not close the bubble's fence early — the user
    // would review a broken fragment while the full code still executes.
    const code = 'print("```markdown fence```")';
    await runTool({ language: "python", code, description: "emit markdown" });

    const input = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(input.promptText).toContain(`\`\`\`\`python\n${code}\n\`\`\`\``);
    expect((input.action.args as { code: string }).code).toBe(code);
  });

  it("outruns even longer backtick runs in the code", async () => {
    const code = "s = '`````'"; // five-backtick run → six-backtick fence
    await runTool({ language: "python", code, description: "string of backticks" });

    const input = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(input.promptText).toContain(`\`\`\`\`\`\`python\n${code}\n\`\`\`\`\`\``);
  });

  it("strips backticks from the description so it cannot forge a fence above the code block", async () => {
    // The description sits above the fence in the same bubble: a backtick run
    // in it could pair with the code block's opening fence and break the
    // program out of its verbatim <pre> rendering. The code fence must stay
    // intact and the description must arrive backtick-free.
    await runTool({
      language: "python",
      code: "print(1)",
      description: "renders ``` fences",
    });

    const input = vi.mocked(raisePendingConfirmation).mock.calls[0][2];
    expect(input.promptText).toContain("renders ''' fences");
    expect(input.promptText).toContain("```python\nprint(1)\n```");
    expect(input.summary).toBe("run python code: renders ''' fences");
  });

  it("refuses code whose fence growth would overflow the approval bubble — before any row exists", async () => {
    // 2500 backticks (under the 3000 code cap) → two ~2501-char fences →
    // promptText far past Telegram's 4096 limit. Raising would insert a
    // pending row whose bubble can never be delivered (invisible approval),
    // so the tool must bail out first.
    const code = "`".repeat(2500);
    const result = await runTool({ language: "python", code, description: "backtick flood" });

    expect(result.pending).toBe(false);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("backtick");
    expect(vi.mocked(raisePendingConfirmation)).not.toHaveBeenCalled();
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
