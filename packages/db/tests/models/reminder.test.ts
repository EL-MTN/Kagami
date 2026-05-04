import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it } from "vitest";

import {
  Reminder,
  cleanupFiredReminders,
  createReminder,
  deleteReminder,
  getPendingReminders,
  getRecentlyFiredReminders,
  listRemindersForChat,
  markReminderFired,
} from "../../src/models/reminder";

withTestDb({ syncIndexes: false });

describe("createReminder", () => {
  it("inserts a row with fired=false", async () => {
    const r = await createReminder("chat-1", "buy milk", new Date("2026-06-01T12:00:00Z"));
    expect(r.fired).toBe(false);
    expect(r.message).toBe("buy milk");
  });
});

describe("getPendingReminders", () => {
  it("returns un-fired reminders whose fireAt is past, oldest-first", async () => {
    const past = await createReminder("chat-1", "old", new Date(Date.now() - 60_000));
    const past2 = await createReminder("chat-1", "older", new Date(Date.now() - 120_000));
    await createReminder("chat-1", "future", new Date(Date.now() + 60_000));

    const rows = await getPendingReminders();
    expect(rows.map((r) => r.message)).toEqual(["older", "old"]);
    // Sanity:
    expect(rows.map((r) => r.id as string)).toEqual([past2.id, past.id]);
  });

  it("excludes already-fired reminders", async () => {
    const r = await createReminder("chat-1", "old", new Date(Date.now() - 60_000));
    await markReminderFired(r.id as string);
    expect(await getPendingReminders()).toEqual([]);
  });

  it("aggregates across chats (this query is global by design)", async () => {
    await createReminder("chat-1", "a", new Date(Date.now() - 60_000));
    await createReminder("chat-2", "b", new Date(Date.now() - 60_000));
    expect((await getPendingReminders()).map((r) => r.message).sort()).toEqual(["a", "b"]);
  });
});

describe("markReminderFired", () => {
  it("flips fired=true", async () => {
    const r = await createReminder("chat-1", "x", new Date());
    await markReminderFired(r.id as string);
    const reread = await Reminder.findById(r._id);
    expect(reread?.fired).toBe(true);
  });
});

describe("listRemindersForChat", () => {
  it("returns un-fired rows for the chat, sorted by fireAt asc", async () => {
    const later = await createReminder("chat-1", "later", new Date("2026-06-01T15:00:00Z"));
    const sooner = await createReminder("chat-1", "sooner", new Date("2026-06-01T12:00:00Z"));
    await createReminder("chat-2", "other-chat", new Date("2026-06-01T13:00:00Z"));
    const fired = await createReminder("chat-1", "fired", new Date("2026-06-01T11:00:00Z"));
    await markReminderFired(fired.id as string);

    const rows = await listRemindersForChat("chat-1");
    expect(rows.map((r) => r.id as string)).toEqual([sooner.id, later.id]);
  });

  it("returns [] for a chat with no reminders", async () => {
    expect(await listRemindersForChat("nobody")).toEqual([]);
  });
});

describe("getRecentlyFiredReminders", () => {
  it("returns fired reminders within the time window, newest-first", async () => {
    const recent = await createReminder("chat-1", "recent", new Date(Date.now() - 60_000));
    const older = await createReminder(
      "chat-1",
      "older",
      new Date(Date.now() - 30 * 60 * 60 * 1000),
    );
    await markReminderFired(recent.id as string);
    await markReminderFired(older.id as string);

    const rows = await getRecentlyFiredReminders("chat-1", 12);
    expect(rows.map((r) => r.id as string)).toEqual([recent.id]);
  });

  it("scopes to chatId", async () => {
    const a = await createReminder("chat-1", "a", new Date(Date.now() - 60_000));
    const b = await createReminder("chat-2", "b", new Date(Date.now() - 60_000));
    await markReminderFired(a.id as string);
    await markReminderFired(b.id as string);
    expect((await getRecentlyFiredReminders("chat-1")).map((r) => r.id as string)).toEqual([a.id]);
  });
});

describe("deleteReminder", () => {
  it("returns true for an existing row, removes it", async () => {
    const r = await createReminder("chat-1", "x", new Date());
    expect(await deleteReminder(r.id as string)).toBe(true);
    expect(await Reminder.findById(r._id)).toBeNull();
  });

  it("returns false for a non-existent id", async () => {
    expect(await deleteReminder("000000000000000000000000")).toBe(false);
  });
});

describe("cleanupFiredReminders", () => {
  it("deletes only fired rows older than the cutoff", async () => {
    const old = await createReminder(
      "chat-1",
      "old",
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    );
    await markReminderFired(old.id as string);
    const recent = await createReminder("chat-1", "recent", new Date(Date.now() - 60_000));
    await markReminderFired(recent.id as string);
    const oldUnfired = await createReminder(
      "chat-1",
      "old-but-unfired",
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    );

    const removed = await cleanupFiredReminders(30);
    expect(removed).toBe(1);
    expect(await Reminder.findById(old._id)).toBeNull();
    expect(await Reminder.findById(recent._id)).not.toBeNull();
    expect(await Reminder.findById(oldUnfired._id)).not.toBeNull();
  });
});
