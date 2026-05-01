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

import { PendingConfirmation } from "@mashiro/db";
import { createRequestConfirmationTool } from "../../../src/ai/tools/request-confirmation";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

describe("requestConfirmation tool", () => {
  let adapter: ReturnType<typeof fakeAdapter>;
  beforeEach(() => {
    adapter = fakeAdapter({ fakeMessageId: "tg-msg-42" });
  });

  it("persists a pending row, prompts the adapter, and returns { pending: true, confirmationId }", async () => {
    const tool = createRequestConfirmationTool(
      "chat-1",
      adapter,
    ) as unknown as ExecutableTool;

    const result = await tool.execute({
      summary: "send email to alice",
      action: { tool: "sendEmail", args: { to: "alice@x.com", subject: "hi", body: "hi" } },
    });

    expect(result.pending).toBe(true);
    expect(typeof result.confirmationId).toBe("string");

    const id = result.confirmationId as string;
    const persisted = await PendingConfirmation.findById(id);
    expect(persisted?.status).toBe("pending");
    expect(persisted?.chatId).toBe("chat-1");
    expect(persisted?.action.tool).toBe("sendEmail");
    expect(persisted?.summary).toBe("send email to alice");
    expect(persisted?.origin).toBe("conversation");

    expect(adapter.calls.sendConfirmationPrompt).toEqual([
      {
        chatId: "chat-1",
        text: "Approve action?\n\nsend email to alice",
        confirmationId: id,
      },
    ]);
    // setPromptMessageId stamped the adapter's returned messageId.
    expect(persisted?.promptMessageId).toBe("tg-msg-42");
  });

  it("respects an explicit origin (skill/watcher) and originRef", async () => {
    const tool = createRequestConfirmationTool(
      "chat-1",
      adapter,
      "skill",
      "skill-log-7",
    ) as unknown as ExecutableTool;

    const result = await tool.execute({
      summary: "delete event ev-1",
      action: { tool: "manageCalendar", args: { action: "delete", eventId: "ev-1" } },
    });
    const persisted = await PendingConfirmation.findById(result.confirmationId as string);
    expect(persisted?.origin).toBe("skill");
    expect(persisted?.originRef).toBe("skill-log-7");
  });

  it("rejects an action.tool that is not in GATED_TOOL_NAMES (defense-in-depth check)", async () => {
    // The Zod enum at the inputSchema would normally catch this before
    // execute runs, but the SDK invokes our execute() directly in tests
    // (and the runtime guard exists as defense-in-depth against schema drift).
    // Pinning the runtime guard's behavior.
    const tool = createRequestConfirmationTool(
      "chat-1",
      adapter,
    ) as unknown as ExecutableTool;
    const result = await tool.execute({
      summary: "do something",
      action: { tool: "rememberFact", args: {} },
    });
    expect(result).toEqual({
      pending: false,
      success: false,
      reason: "tool is not approval-gated",
    });
  });
});
