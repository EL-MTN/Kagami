import { withTestDb } from "@mashiro/test-utils";
import { describe, expect, it, vi } from "vitest";

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

import { Reminder, createReminder } from "@mashiro/db";
import { createManageRemindersTool } from "../../../src/ai/tools/manage-reminders";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = createManageRemindersTool("chat-1") as unknown as ExecutableTool;

describe("manageReminders tool — create", () => {
  it("rejects when message or fireAt are missing", async () => {
    expect(await tool.execute({ action: "create" })).toEqual({
      success: false,
      reason: "message and fireAt are required to create a reminder",
    });
    expect(await tool.execute({ action: "create", message: "x" })).toEqual({
      success: false,
      reason: "message and fireAt are required to create a reminder",
    });
  });

  it("creates the reminder for the configured chat", async () => {
    const fireAt = new Date("2026-06-01T12:00:00Z");
    const result = await tool.execute({
      action: "create",
      message: "buy milk",
      fireAt: fireAt.toISOString(),
    });
    expect(result.success).toBe(true);
    expect(result.message).toBe("buy milk");
    const persisted = await Reminder.findById(result.reminderId);
    expect(persisted?.chatId).toBe("chat-1");
    expect(persisted?.message).toBe("buy milk");
  });
});

describe("manageReminders tool — list", () => {
  it("returns scoped, formatted entries; ISO-formats fireAt", async () => {
    await createReminder("chat-1", "in chat 1", new Date("2026-06-01T12:00:00Z"));
    await createReminder("chat-2", "other chat", new Date("2026-06-01T12:00:00Z"));
    const result = await tool.execute({ action: "list" });
    expect(result.count).toBe(1);
    const reminders = result.reminders as Array<Record<string, unknown>>;
    expect(reminders[0]!.message).toBe("in chat 1");
    expect(reminders[0]!.fireAt).toBe("2026-06-01T12:00:00.000Z");
  });
});

describe("manageReminders tool — delete", () => {
  it("requires reminderId", async () => {
    expect(await tool.execute({ action: "delete" })).toEqual({
      success: false,
      reason: "reminderId is required for delete",
    });
  });

  it("returns success:true when removed, false when missing", async () => {
    const r = await createReminder("chat-1", "x", new Date());
    const ok = await tool.execute({ action: "delete", reminderId: r.id as string });
    expect(ok).toEqual({ success: true, deleted: r.id });
    const missing = await tool.execute({
      action: "delete",
      reminderId: "000000000000000000000000",
    });
    expect(missing).toEqual({ success: false, reason: "Reminder not found" });
  });
});
