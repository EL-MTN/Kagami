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

const { mockAppendResolution } = vi.hoisted(() => ({ mockAppendResolution: vi.fn() }));
vi.mock("../../../src/services/confirmation-events", () => ({
  appendConfirmationResolution: mockAppendResolution,
}));

import {
  PendingConfirmation,
  createPendingConfirmation,
  setPromptMessageId,
} from "@mashiro/db";
import { createCancelConfirmationTool } from "../../../src/ai/tools/cancel-confirmation";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockAppendResolution.mockReset().mockResolvedValue(undefined);
});

async function seedPending() {
  return createPendingConfirmation({
    chatId: "chat-1",
    summary: "send email to alice",
    action: { tool: "sendEmail", args: { to: "alice@x.com" } },
  });
}

describe("cancelConfirmation tool", () => {
  it("cancels a pending row, edits the prompt bubble, and appends a resolution event", async () => {
    const adapter = fakeAdapter();
    const row = await seedPending();
    await setPromptMessageId(row.id as string, "tg-99");
    const tool = createCancelConfirmationTool(
      "chat-1",
      adapter,
      "user-1",
    ) as unknown as ExecutableTool;

    const result = await tool.execute({
      confirmationId: row.id as string,
      reason: "changed my mind",
    });

    expect(result).toEqual({ success: true, confirmationId: row.id });
    const reloaded = await PendingConfirmation.findById(row._id);
    expect(reloaded?.status).toBe("cancelled");
    expect(reloaded?.resultText).toBe("changed my mind");
    expect(adapter.calls.editConfirmationPrompt).toEqual([
      {
        chatId: "chat-1",
        messageId: "tg-99",
        text: "✗ Cancelled · send email to alice\nchanged my mind",
      },
    ]);
    expect(mockAppendResolution).toHaveBeenCalledWith(
      "chat-1",
      "user-1",
      expect.objectContaining({
        verdict: "cancelled",
        summary: "send email to alice",
        resultText: "changed my mind",
      }),
    );
  });

  it("returns 'confirmation not found' for an unknown id", async () => {
    const tool = createCancelConfirmationTool(
      "chat-1",
      fakeAdapter(),
    ) as unknown as ExecutableTool;
    const result = await tool.execute({ confirmationId: "000000000000000000000000" });
    expect(result).toEqual({ success: false, reason: "confirmation not found" });
  });

  it("rejects when the confirmation belongs to a different chat", async () => {
    const row = await seedPending();
    const tool = createCancelConfirmationTool(
      "chat-2",
      fakeAdapter(),
    ) as unknown as ExecutableTool;
    const result = await tool.execute({ confirmationId: row.id as string });
    expect(result).toEqual({
      success: false,
      reason: "confirmation belongs to a different chat",
    });
  });

  it("returns the existing status when already-resolved (idempotent on re-cancel)", async () => {
    const row = await seedPending();
    await PendingConfirmation.findByIdAndUpdate(row._id, { status: "approved" });
    const tool = createCancelConfirmationTool(
      "chat-1",
      fakeAdapter(),
    ) as unknown as ExecutableTool;
    const result = await tool.execute({ confirmationId: row.id as string });
    expect(result).toEqual({ success: false, reason: "already approved" });
  });

  it("falls back to chatId for userId when not supplied (cron-triggered context)", async () => {
    const adapter = fakeAdapter();
    const row = await seedPending();
    const tool = createCancelConfirmationTool(
      "chat-1",
      adapter,
      // userId omitted
    ) as unknown as ExecutableTool;
    await tool.execute({ confirmationId: row.id as string });
    expect(mockAppendResolution).toHaveBeenCalledWith(
      "chat-1",
      "chat-1", // fallback
      expect.any(Object),
    );
  });

  it("doesn't try to edit the prompt when no promptMessageId was stored", async () => {
    const adapter = fakeAdapter();
    const row = await seedPending();
    const tool = createCancelConfirmationTool(
      "chat-1",
      adapter,
    ) as unknown as ExecutableTool;
    await tool.execute({ confirmationId: row.id as string });
    expect(adapter.calls.editConfirmationPrompt).toEqual([]);
  });
});
