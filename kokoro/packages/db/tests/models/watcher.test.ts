import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it } from "vitest";

import {
  Watcher,
  WatcherLog,
  archiveExpiredWatchers,
  archiveWatcher,
  claimPendingManualWatcherRun,
  cleanupOldWatcherLogs,
  completeWatcherLog,
  createWatcher,
  createWatcherLog,
  defaultExpiresAt,
  deleteWatcher,
  failWatcherLog,
  getDueWatchers,
  getWatcherById,
  getWatcherByName,
  getWatcherLogs,
  isWatcherRunning,
  listWatchersForChat,
  recordWatcherObservation,
  recordWatcherStateOnly,
  requestManualWatcherRun,
  resetStaleRunningWatcherLogs,
  updateWatcher,
  type WatcherInput,
} from "../../src/models/watcher";

withTestDb();

const baseInput: WatcherInput = {
  name: "stock-alert",
  description: "watch the stock price",
  prompt: "Has the price moved?",
  cronSchedule: "0 * * * *",
};

describe("createWatcher + listWatchersForChat", () => {
  it("creates with reportMode=alert and 30-day default expiry", async () => {
    const before = Date.now();
    const w = await createWatcher("chat-1", baseInput);
    expect(w.reportMode).toBe("alert");
    expect(w.fireCount).toBe(0);
    expect(w.enabled).toBe(true);
    expect(w.archivedAt).toBeNull();
    // ~30 days from now (defaultExpiresAt).
    const ttl = w.expiresAt!.getTime() - before;
    expect(ttl).toBeGreaterThan(29.5 * 24 * 60 * 60 * 1000);
    expect(ttl).toBeLessThan(30.5 * 24 * 60 * 60 * 1000);
  });

  it("respects an explicit expiresAt and oneShot/maxFires/cooldown/snooze inputs", async () => {
    const expiresAt = new Date("2026-12-31T00:00:00Z");
    const snoozedUntil = new Date("2026-06-01T00:00:00Z");
    const w = await createWatcher("chat-1", {
      ...baseInput,
      expiresAt,
      oneShot: true,
      maxFires: 3,
      cooldownMs: 60_000,
      snoozedUntil,
    });
    expect(w.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    expect(w.oneShot).toBe(true);
    expect(w.maxFires).toBe(3);
    expect(w.cooldownMs).toBe(60_000);
    expect(w.snoozedUntil?.toISOString()).toBe(snoozedUntil.toISOString());
  });

  it("rejects duplicate names within a chat (partial unique index)", async () => {
    await createWatcher("chat-1", baseInput);
    await expect(createWatcher("chat-1", baseInput)).rejects.toThrow();
  });

  it("permits the same name in a different chat", async () => {
    await createWatcher("chat-1", baseInput);
    await expect(createWatcher("chat-2", baseInput)).resolves.toBeDefined();
  });

  it("permits reusing a name after the previous holder is archived", async () => {
    const first = await createWatcher("chat-1", baseInput);
    await archiveWatcher(first.id);
    await expect(createWatcher("chat-1", baseInput)).resolves.toBeDefined();
  });

  it("listWatchersForChat hides archived rows by default", async () => {
    const a = await createWatcher("chat-1", { ...baseInput, name: "a" });
    const b = await createWatcher("chat-1", { ...baseInput, name: "b" });
    await archiveWatcher(b.id);
    const live = await listWatchersForChat("chat-1");
    expect(live.map((w) => w.id)).toEqual([a.id]);
    const all = await listWatchersForChat("chat-1", { includeArchived: true });
    expect(all).toHaveLength(2);
  });
});

describe("defaultExpiresAt", () => {
  it("returns 30 days after the supplied origin", () => {
    const origin = new Date("2026-01-01T00:00:00Z");
    const out = defaultExpiresAt(origin);
    expect(out.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });
});

describe("getWatcherById / getWatcherByName", () => {
  it("getWatcherById is chat-scoped when chatId is supplied", async () => {
    const w = await createWatcher("chat-1", baseInput);
    expect(await getWatcherById(w.id, "chat-1")).not.toBeNull();
    expect(await getWatcherById(w.id, "chat-2")).toBeNull();
  });

  it("getWatcherByName returns null for archived rows", async () => {
    const w = await createWatcher("chat-1", baseInput);
    await archiveWatcher(w.id);
    expect(await getWatcherByName("chat-1", baseInput.name)).toBeNull();
  });
});

describe("updateWatcher", () => {
  it("patches the provided fields and returns the new doc", async () => {
    const w = await createWatcher("chat-1", baseInput);
    const updated = await updateWatcher(w.id, {
      description: "new desc",
      cooldownMs: 30_000,
    });
    expect(updated?.description).toBe("new desc");
    expect(updated?.cooldownMs).toBe(30_000);
    // Untouched fields preserved.
    expect(updated?.name).toBe(baseInput.name);
  });

  it("scopes by chatId when supplied — wrong chat returns null without modifying", async () => {
    const w = await createWatcher("chat-1", baseInput);
    const result = await updateWatcher(w.id, { description: "hijacked" }, "chat-2");
    expect(result).toBeNull();
    const reloaded = await getWatcherById(w.id);
    expect(reloaded?.description).toBe(baseInput.description);
  });
});

describe("deleteWatcher", () => {
  it("removes the watcher and its associated logs, returns true", async () => {
    const w = await createWatcher("chat-1", baseInput);
    await createWatcherLog(w.id, "cron");
    const removed = await deleteWatcher(w.id);
    expect(removed).toBe(true);
    expect(await Watcher.findById(w.id)).toBeNull();
    expect(await WatcherLog.countDocuments({ watcherId: w._id })).toBe(0);
  });

  it("returns false when no watcher matches", async () => {
    expect(await deleteWatcher("000000000000000000000000")).toBe(false);
  });
});

describe("archiveExpiredWatchers", () => {
  it("archives only non-archived rows whose expiresAt has passed", async () => {
    const expired = await createWatcher("chat-1", {
      ...baseInput,
      name: "expired",
      expiresAt: new Date(Date.now() - 1000),
    });
    const future = await createWatcher("chat-1", {
      ...baseInput,
      name: "future",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const noExpiry = await createWatcher("chat-1", {
      ...baseInput,
      name: "no-expiry",
      expiresAt: null,
    });

    const count = await archiveExpiredWatchers();
    expect(count).toBe(1);
    expect((await getWatcherById(expired.id))?.archivedAt).not.toBeNull();
    expect((await getWatcherById(future.id))?.archivedAt).toBeNull();
    expect((await getWatcherById(noExpiry.id))?.archivedAt).toBeNull();
  });
});

describe("getDueWatchers", () => {
  it("returns enabled, non-archived, non-expired rows whose nextRunAt is in the past", async () => {
    const past = await createWatcher("chat-1", {
      ...baseInput,
      name: "due",
      nextRunAt: new Date(Date.now() - 1000),
    });
    await createWatcher("chat-1", {
      ...baseInput,
      name: "future",
      nextRunAt: new Date(Date.now() + 60_000),
    });
    const disabled = await createWatcher("chat-1", {
      ...baseInput,
      name: "disabled",
      nextRunAt: new Date(Date.now() - 1000),
      enabled: false,
    });
    const archived = await createWatcher("chat-1", {
      ...baseInput,
      name: "archived",
      nextRunAt: new Date(Date.now() - 1000),
    });
    await archiveWatcher(archived.id);
    const expiredPastDue = await createWatcher("chat-1", {
      ...baseInput,
      name: "expired-past-due",
      nextRunAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() - 1000),
    });

    const due = await getDueWatchers();
    expect(due.map((w) => w.id).sort()).toEqual([past.id].sort());
    // Sanity that we excluded the others.
    expect(due.map((w) => w.id)).not.toContain(disabled.id);
    expect(due.map((w) => w.id)).not.toContain(expiredPastDue.id);
  });

  it("returns rows whose expiresAt is null (no expiry)", async () => {
    const w = await createWatcher("chat-1", {
      ...baseInput,
      nextRunAt: new Date(Date.now() - 1000),
      expiresAt: null,
    });
    const due = await getDueWatchers();
    expect(due.map((d) => d.id)).toContain(w.id);
  });
});

describe("recordWatcherObservation / recordWatcherStateOnly", () => {
  it("recordWatcherObservation with triggered=true updates lastState, lastFiredAt, and increments fireCount", async () => {
    const w = await createWatcher("chat-1", baseInput);
    await recordWatcherObservation(w.id, {
      newState: "price=100",
      triggered: true,
    });
    const reloaded = await getWatcherById(w.id);
    expect(reloaded?.lastState).toBe("price=100");
    expect(reloaded?.lastFiredAt).toBeInstanceOf(Date);
    expect(reloaded?.fireCount).toBe(1);
  });

  it("recordWatcherObservation with triggered=false rolls forward lastState only — fireCount unchanged", async () => {
    const w = await createWatcher("chat-1", baseInput);
    await recordWatcherObservation(w.id, {
      newState: "price=99",
      triggered: false,
    });
    const reloaded = await getWatcherById(w.id);
    expect(reloaded?.lastState).toBe("price=99");
    expect(reloaded?.lastFiredAt).toBeNull();
    expect(reloaded?.fireCount).toBe(0);
  });

  it("recordWatcherStateOnly never touches fire counters even after a previous fire", async () => {
    const w = await createWatcher("chat-1", baseInput);
    await recordWatcherObservation(w.id, { newState: "s1", triggered: true });
    await recordWatcherStateOnly(w.id, "s2");
    const reloaded = await getWatcherById(w.id);
    expect(reloaded?.lastState).toBe("s2");
    expect(reloaded?.fireCount).toBe(1);
  });
});

describe("manual-run lifecycle", () => {
  it("requestManualWatcherRun stamps manualRunRequestedAt", async () => {
    const w = await createWatcher("chat-1", baseInput);
    const updated = await requestManualWatcherRun(w.id);
    expect(updated?.manualRunRequestedAt).toBeInstanceOf(Date);
  });

  it("claimPendingManualWatcherRun is atomic — exactly one concurrent claimer wins", async () => {
    const w = await createWatcher("chat-1", baseInput);
    await requestManualWatcherRun(w.id);
    const results = await Promise.all([
      claimPendingManualWatcherRun(),
      claimPendingManualWatcherRun(),
      claimPendingManualWatcherRun(),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    // After claim, manualRunRequestedAt is cleared on the winning row.
    const reloaded = await getWatcherById(w.id);
    expect(reloaded?.manualRunRequestedAt).toBeNull();
  });

  it("claimPendingManualWatcherRun ignores archived and disabled rows", async () => {
    const archived = await createWatcher("chat-1", { ...baseInput, name: "a" });
    await requestManualWatcherRun(archived.id);
    await archiveWatcher(archived.id);

    const disabled = await createWatcher("chat-1", { ...baseInput, name: "b", enabled: false });
    await requestManualWatcherRun(disabled.id);

    expect(await claimPendingManualWatcherRun()).toBeNull();
  });
});

describe("watcher logs", () => {
  it("createWatcherLog → completeWatcherLog roundtrip persists status/triggered/summary", async () => {
    const w = await createWatcher("chat-1", baseInput);
    const log = await createWatcherLog(w.id, "cron");
    expect(log.status).toBe("running");
    await completeWatcherLog(log.id, {
      triggered: true,
      summary: "fired",
      newState: "s1",
    });
    const [reloaded] = await getWatcherLogs(w.id);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.triggered).toBe(true);
    expect(reloaded?.suppressed).toBe(false);
    expect(reloaded?.summary).toBe("fired");
    expect(reloaded?.newState).toBe("s1");
  });

  it("completeWatcherLog with suppressed=true records both triggered AND the suppression", async () => {
    const w = await createWatcher("chat-1", baseInput);
    const log = await createWatcherLog(w.id, "cron");
    await completeWatcherLog(log.id, {
      triggered: true,
      suppressed: true,
      summary: "would-fire-but-cooldown",
      newState: "s2",
    });
    const [reloaded] = await getWatcherLogs(w.id);
    expect(reloaded?.suppressed).toBe(true);
  });

  it("failWatcherLog persists the failure summary and status", async () => {
    const w = await createWatcher("chat-1", baseInput);
    const log = await createWatcherLog(w.id, "manual");
    await failWatcherLog(log.id, "openai 500");
    const [reloaded] = await getWatcherLogs(w.id);
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.summary).toBe("openai 500");
  });

  it("isWatcherRunning is true while a log is running and within the 15 min stale window", async () => {
    const w = await createWatcher("chat-1", baseInput);
    expect(await isWatcherRunning(w.id)).toBe(false);
    await createWatcherLog(w.id, "cron");
    expect(await isWatcherRunning(w.id)).toBe(true);
  });

  it("isWatcherRunning is false for logs older than the stale threshold", async () => {
    const w = await createWatcher("chat-1", baseInput);
    const log = await createWatcherLog(w.id, "cron");
    // Backdate startedAt by 20 minutes.
    await WatcherLog.collection.updateOne(
      { _id: log._id },
      { $set: { startedAt: new Date(Date.now() - 20 * 60 * 1000) } },
    );
    expect(await isWatcherRunning(w.id)).toBe(false);
  });

  it("resetStaleRunningWatcherLogs flips stale running rows to failed", async () => {
    const w = await createWatcher("chat-1", baseInput);
    const fresh = await createWatcherLog(w.id, "cron");
    const stale = await createWatcherLog(w.id, "cron");
    await WatcherLog.collection.updateOne(
      { _id: stale._id },
      { $set: { startedAt: new Date(Date.now() - 20 * 60 * 1000) } },
    );

    const reset = await resetStaleRunningWatcherLogs();
    expect(reset).toBe(1);
    expect((await WatcherLog.findById(stale._id))?.status).toBe("failed");
    expect((await WatcherLog.findById(fresh._id))?.status).toBe("running");
  });

  it("cleanupOldWatcherLogs deletes only non-running logs older than the cutoff", async () => {
    const w = await createWatcher("chat-1", baseInput);
    const old = await createWatcherLog(w.id, "cron");
    await completeWatcherLog(old.id, {
      triggered: false,
      summary: "ok",
      newState: "s",
    });
    await WatcherLog.collection.updateOne(
      { _id: old._id },
      { $set: { startedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) } },
    );
    const recent = await createWatcherLog(w.id, "cron");
    await completeWatcherLog(recent.id, {
      triggered: false,
      summary: "ok",
      newState: "s",
    });

    const removed = await cleanupOldWatcherLogs(90);
    expect(removed).toBe(1);
    expect(await WatcherLog.findById(old._id)).toBeNull();
    expect(await WatcherLog.findById(recent._id)).not.toBeNull();
  });
});
