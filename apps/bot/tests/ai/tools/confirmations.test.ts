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
import {
  createRequestConfirmationTool,
  createCancelConfirmationTool,
} from "../../../src/ai/tools/confirmations";

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

// ─── requestConfirmation ─────────────────────────────────────────────────────

describe("requestConfirmation tool", () => {
  let adapter: ReturnType<typeof fakeAdapter>;
  beforeEach(() => {
    adapter = fakeAdapter({ fakeMessageId: "tg-msg-42" });
  });

  it("persists a pending row, prompts the adapter, and returns { pending: true, confirmationId }", async () => {
    const tool = createRequestConfirmationTool("chat-1", adapter) as unknown as ExecutableTool;

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

  it("respects an explicit origin (routine/watcher) and originRef", async () => {
    const tool = createRequestConfirmationTool(
      "chat-1",
      adapter,
      "routine",
      "routine-log-7",
    ) as unknown as ExecutableTool;

    const result = await tool.execute({
      summary: "delete event ev-1",
      action: { tool: "manageCalendar", args: { action: "delete", eventId: "ev-1" } },
    });
    const persisted = await PendingConfirmation.findById(result.confirmationId as string);
    expect(persisted?.origin).toBe("routine");
    expect(persisted?.originRef).toBe("routine-log-7");
  });

  it("rejects an action.tool that is not in GATED_TOOL_NAMES (defense-in-depth check)", async () => {
    // The Zod enum at the inputSchema would normally catch this before
    // execute runs, but the SDK invokes our execute() directly in tests
    // (and the runtime guard exists as defense-in-depth against schema drift).
    // Pinning the runtime guard's behavior.
    const tool = createRequestConfirmationTool("chat-1", adapter) as unknown as ExecutableTool;
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

// ─── cancelConfirmation ──────────────────────────────────────────────────────

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
    const tool = createCancelConfirmationTool("chat-1", adapter) as unknown as ExecutableTool;
    await tool.execute({ confirmationId: row.id as string });
    expect(adapter.calls.editConfirmationPrompt).toEqual([]);
  });
});
