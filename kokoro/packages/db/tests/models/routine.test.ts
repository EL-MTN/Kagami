import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it } from "vitest";

import {
  Routine,
  RoutineLog,
  advanceRoutineNextRunAt,
  claimPendingManualRun,
  cleanupOldRoutineLogs,
  completeRoutineLog,
  createRoutine,
  createRoutineLog,
  deleteRoutine,
  failRoutineLog,
  getDueRoutines,
  getRoutineById,
  getRoutineByName,
  getRoutineHealth,
  getRoutineLogs,
  isRoutineRunning,
  listRoutinesForChat,
  requestManualRun,
  resetStaleRunningRoutineLogs,
  routineNeedsAttention,
  updateRoutine,
  updateRoutineIfVersion,
  type RoutineHealth,
  type RoutineInput,
} from "../../src/models/routine";

withTestDb();

const baseInput: RoutineInput = {
  name: "summarize-inbox",
  description: "summarize unread emails",
  prompt: "Summarize today's inbox",
  reportMode: "always",
};

describe("createRoutine + listRoutinesForChat", () => {
  it("creates with purity defaulted to 'action'", async () => {
    const s = await createRoutine("chat-1", baseInput);
    expect(s.purity).toBe("action");
    expect(s.enabled).toBe(true);
    expect(s.parameters).toEqual([]);
  });

  it("respects an explicit purity='read'", async () => {
    const s = await createRoutine("chat-1", { ...baseInput, purity: "read" });
    expect(s.purity).toBe("read");
  });

  it("rejects duplicate names per chat", async () => {
    await createRoutine("chat-1", baseInput);
    await expect(createRoutine("chat-1", baseInput)).rejects.toThrow();
  });

  it("permits the same name in a different chat", async () => {
    await createRoutine("chat-1", baseInput);
    await expect(createRoutine("chat-2", baseInput)).resolves.toBeDefined();
  });

  it("listRoutinesForChat returns rows newest-first", async () => {
    const a = await createRoutine("chat-1", { ...baseInput, name: "a" });
    // Backdate `a` so the sort by createdAt is deterministic — successive
    // create() calls in tests can land on the same millisecond, which makes
    // the ordering ambiguous.
    await Routine.collection.updateOne(
      { _id: a._id },
      { $set: { createdAt: new Date(Date.now() - 1000) } },
    );
    const b = await createRoutine("chat-1", { ...baseInput, name: "b" });
    const rows = await listRoutinesForChat("chat-1");
    expect(rows.map((s) => s.id)).toEqual([b.id, a.id]);
  });
});

describe("getRoutineById / getRoutineByName", () => {
  it("getRoutineById is chat-scoped when chatId is supplied", async () => {
    const s = await createRoutine("chat-1", baseInput);
    expect(await getRoutineById(s.id, "chat-1")).not.toBeNull();
    expect(await getRoutineById(s.id, "chat-2")).toBeNull();
  });

  it("getRoutineByName returns null for non-matching chat", async () => {
    await createRoutine("chat-1", baseInput);
    expect(await getRoutineByName("chat-2", baseInput.name)).toBeNull();
  });
});

describe("updateRoutine", () => {
  it("patches and returns the new doc", async () => {
    const s = await createRoutine("chat-1", baseInput);
    const out = await updateRoutine(s.id, { description: "new" });
    expect(out?.description).toBe("new");
  });

  it("respects chatId scoping", async () => {
    const s = await createRoutine("chat-1", baseInput);
    expect(await updateRoutine(s.id, { description: "hijack" }, "chat-2")).toBeNull();
  });
});

describe("deleteRoutine", () => {
  it("removes routine and cascades to its logs", async () => {
    const s = await createRoutine("chat-1", baseInput);
    await createRoutineLog(s.id, "manual");
    await deleteRoutine(s.id);
    expect(await Routine.findById(s.id)).toBeNull();
    expect(await RoutineLog.countDocuments({ routineId: s._id })).toBe(0);
  });

  it("returns false for a non-existent id", async () => {
    expect(await deleteRoutine("000000000000000000000000")).toBe(false);
  });
});

describe("getDueRoutines + advanceRoutineNextRunAt", () => {
  it("returns enabled rows whose nextRunAt is past and that have a cronSchedule", async () => {
    const due = await createRoutine("chat-1", {
      ...baseInput,
      name: "due",
      cronSchedule: "0 * * * *",
      nextRunAt: new Date(Date.now() - 1000),
    });
    await createRoutine("chat-1", {
      ...baseInput,
      name: "no-cron",
      nextRunAt: new Date(Date.now() - 1000),
    });
    await createRoutine("chat-1", {
      ...baseInput,
      name: "future",
      cronSchedule: "0 * * * *",
      nextRunAt: new Date(Date.now() + 60_000),
    });
    await createRoutine("chat-1", {
      ...baseInput,
      name: "disabled",
      cronSchedule: "0 * * * *",
      nextRunAt: new Date(Date.now() - 1000),
      enabled: false,
    });

    const rows = await getDueRoutines();
    expect(rows.map((r) => r.id)).toEqual([due.id]);
  });

  it("advanceRoutineNextRunAt patches nextRunAt", async () => {
    const s = await createRoutine("chat-1", { ...baseInput, cronSchedule: "0 * * * *" });
    const target = new Date(Date.now() + 60_000);
    await advanceRoutineNextRunAt(s.id, target);
    const reloaded = await getRoutineById(s.id);
    expect(reloaded?.nextRunAt?.getTime()).toBe(target.getTime());
  });
});

describe("manual run lifecycle", () => {
  it("requestManualRun stamps manualRunRequestedAt", async () => {
    const s = await createRoutine("chat-1", baseInput);
    const out = await requestManualRun(s.id);
    expect(out?.manualRunRequestedAt).toBeInstanceOf(Date);
  });

  it("claimPendingManualRun is atomic — exactly one concurrent claimer wins", async () => {
    const s = await createRoutine("chat-1", baseInput);
    await requestManualRun(s.id);
    const results = await Promise.all([
      claimPendingManualRun(),
      claimPendingManualRun(),
      claimPendingManualRun(),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const reloaded = await getRoutineById(s.id);
    expect(reloaded?.manualRunRequestedAt).toBeNull();
  });

  it("claimPendingManualRun ignores disabled rows", async () => {
    const s = await createRoutine("chat-1", { ...baseInput, enabled: false });
    await requestManualRun(s.id);
    expect(await claimPendingManualRun()).toBeNull();
  });

  it("claimPendingManualRun returns null when nothing is pending", async () => {
    await createRoutine("chat-1", baseInput);
    expect(await claimPendingManualRun()).toBeNull();
  });
});

describe("routine logs", () => {
  it("createRoutineLog → completeRoutineLog roundtrip", async () => {
    const s = await createRoutine("chat-1", baseInput);
    const log = await createRoutineLog(s.id, "cron");
    expect(log.status).toBe("running");
    await completeRoutineLog(log.id, "ok");
    const [reloaded] = await getRoutineLogs(s.id);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.summary).toBe("ok");
  });

  it("createRoutineLog with parentLogId records the parent reference", async () => {
    const parentRoutine = await createRoutine("chat-1", { ...baseInput, name: "parent" });
    const childRoutine = await createRoutine("chat-1", { ...baseInput, name: "child" });
    const parentLog = await createRoutineLog(parentRoutine.id, "manual");
    const childLog = await createRoutineLog(childRoutine.id, "routine", {
      parentLogId: parentLog.id,
      parameters: { x: 1 },
    });
    expect(childLog.parentLogId?.toString()).toBe(parentLog._id?.toString());
    expect(childLog.parameters).toEqual({ x: 1 });
  });

  it("failRoutineLog records the failure reason", async () => {
    const s = await createRoutine("chat-1", baseInput);
    const log = await createRoutineLog(s.id, "manual");
    await failRoutineLog(log.id, "boom");
    const [reloaded] = await getRoutineLogs(s.id);
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.summary).toBe("boom");
  });

  it("isRoutineRunning reflects the running window", async () => {
    const s = await createRoutine("chat-1", baseInput);
    expect(await isRoutineRunning(s.id)).toBe(false);
    await createRoutineLog(s.id, "cron");
    expect(await isRoutineRunning(s.id)).toBe(true);
  });

  it("isRoutineRunning is false past the 15 min stale threshold", async () => {
    const s = await createRoutine("chat-1", baseInput);
    const log = await createRoutineLog(s.id, "cron");
    await RoutineLog.collection.updateOne(
      { _id: log._id },
      { $set: { startedAt: new Date(Date.now() - 20 * 60 * 1000) } },
    );
    expect(await isRoutineRunning(s.id)).toBe(false);
  });

  it("resetStaleRunningRoutineLogs flips stale running rows to failed", async () => {
    const s = await createRoutine("chat-1", baseInput);
    const fresh = await createRoutineLog(s.id, "cron");
    const stale = await createRoutineLog(s.id, "cron");
    await RoutineLog.collection.updateOne(
      { _id: stale._id },
      { $set: { startedAt: new Date(Date.now() - 20 * 60 * 1000) } },
    );
    const reset = await resetStaleRunningRoutineLogs();
    expect(reset).toBe(1);
    expect((await RoutineLog.findById(stale._id))?.status).toBe("failed");
    expect((await RoutineLog.findById(fresh._id))?.status).toBe("running");
  });

  it("cleanupOldRoutineLogs deletes only non-running old rows", async () => {
    const s = await createRoutine("chat-1", baseInput);
    const old = await createRoutineLog(s.id, "cron");
    await completeRoutineLog(old.id, "ok");
    await RoutineLog.collection.updateOne(
      { _id: old._id },
      { $set: { startedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) } },
    );
    const recent = await createRoutineLog(s.id, "cron");
    await completeRoutineLog(recent.id, "ok");
    const removed = await cleanupOldRoutineLogs(90);
    expect(removed).toBe(1);
    expect(await RoutineLog.findById(old._id)).toBeNull();
    expect(await RoutineLog.findById(recent._id)).not.toBeNull();
  });
});

describe("getRoutineHealth", () => {
  const readInput: RoutineInput = { ...baseInput, purity: "read" };

  async function logRun(
    routineId: string,
    trigger: "cron" | "manual" | "routine",
    outcome: { fail?: string; summary?: string },
  ) {
    const log = await createRoutineLog(routineId, trigger);
    if (outcome.fail !== undefined) await failRoutineLog(log.id, outcome.fail);
    else await completeRoutineLog(log.id, outcome.summary ?? "ok");
    return log;
  }

  it("tallies failed / empty / no-report runs and excludes composed sub-runs", async () => {
    const s = await createRoutine("chat-1", readInput);
    await logRun(s.id, "cron", { summary: "did the thing" });
    await logRun(s.id, "cron", { fail: "boom" });
    await logRun(s.id, "manual", { summary: "" }); // empty completion
    await logRun(s.id, "cron", { summary: "[no report]" }); // healthy no-op
    await logRun(s.id, "routine", { fail: "nested failure" }); // excluded sub-run

    const [health] = await getRoutineHealth("chat-1");
    expect(health.name).toBe(s.name);
    expect(health.totalRuns).toBe(4); // the "routine"-trigger run is excluded
    expect(health.failedRuns).toBe(1);
    expect(health.emptyRuns).toBe(1);
    expect(health.noReportRuns).toBe(1);
  });

  it("reports lastStatus/lastError/lastRunAt from the most recent counted run", async () => {
    const s = await createRoutine("chat-1", readInput);
    await logRun(s.id, "cron", { summary: "ok" });
    await logRun(s.id, "cron", { fail: "API 429" });

    const [health] = await getRoutineHealth("chat-1");
    expect(health.lastStatus).toBe("failed");
    expect(health.lastError).toBe("API 429");
    expect(health.lastRunAt).toBeInstanceOf(Date);
  });

  it("ignores in-flight running logs", async () => {
    const s = await createRoutine("chat-1", readInput);
    await logRun(s.id, "cron", { summary: "ok" });
    await createRoutineLog(s.id, "cron"); // left running

    const [health] = await getRoutineHealth("chat-1");
    expect(health.totalRuns).toBe(1);
    expect(health.lastStatus).toBe("completed");
  });

  it("returns zeroed health for a routine with no runs", async () => {
    await createRoutine("chat-1", readInput);
    const [health] = await getRoutineHealth("chat-1");
    expect(health.totalRuns).toBe(0);
    expect(health.lastStatus).toBeNull();
    expect(health.lastError).toBeUndefined();
  });

  it("honors the window limit (most recent N only)", async () => {
    const s = await createRoutine("chat-1", readInput);
    await logRun(s.id, "cron", { summary: "a" });
    await logRun(s.id, "cron", { fail: "b" });
    await logRun(s.id, "cron", { fail: "c" });

    const [health] = await getRoutineHealth("chat-1", { window: 2 });
    expect(health.totalRuns).toBe(2);
    expect(health.failedRuns).toBe(2); // the two most recent runs are the failures
  });

  it("excludes disabled routines and scopes to the chat", async () => {
    const enabled = await createRoutine("chat-1", { ...readInput, name: "on" });
    const disabled = await createRoutine("chat-1", { ...readInput, name: "off" });
    await updateRoutine(disabled.id, { enabled: false });
    await createRoutine("chat-2", { ...readInput, name: "other-chat" });

    const health = await getRoutineHealth("chat-1");
    expect(health.map((h) => h.name)).toEqual([enabled.name]);
  });

  it("counts a blank completion as no-report (not empty) for an alert-mode routine", async () => {
    // An alert-mode routine that runs quiet (blank summary on a manual run, or a
    // cron run that omits the literal sentinel) is healthy, not failing.
    const s = await createRoutine("chat-1", { ...baseInput, reportMode: "alert" });
    await logRun(s.id, "manual", { summary: "" });
    await logRun(s.id, "cron", { summary: "" });
    await logRun(s.id, "cron", { summary: "[no report]" });

    const [health] = await getRoutineHealth("chat-1");
    expect(health.emptyRuns).toBe(0);
    expect(health.noReportRuns).toBe(3);
    expect(health.failedRuns).toBe(0);
  });

  it("still counts a blank completion as empty for an always-report routine", async () => {
    const s = await createRoutine("chat-1", { ...baseInput, reportMode: "always" });
    await logRun(s.id, "manual", { summary: "" });
    const [health] = await getRoutineHealth("chat-1");
    expect(health.emptyRuns).toBe(1);
    expect(health.noReportRuns).toBe(0);
  });
});

describe("routineNeedsAttention", () => {
  function fakeHealth(over: Partial<RoutineHealth> = {}): RoutineHealth {
    return {
      routineId: "r",
      name: "r",
      window: 10,
      totalRuns: 0,
      failedRuns: 0,
      emptyRuns: 0,
      noReportRuns: 0,
      lastStatus: null,
      ...over,
    };
  }

  it("is false below the minimum real-run count", () => {
    expect(routineNeedsAttention(fakeHealth({ totalRuns: 3, failedRuns: 3 }))).toBe(false);
  });

  it("is true when the bad rate of real attempts meets the threshold", () => {
    expect(routineNeedsAttention(fakeHealth({ totalRuns: 6, failedRuns: 3 }))).toBe(true);
  });

  it("is false when the bad rate is below the threshold", () => {
    expect(routineNeedsAttention(fakeHealth({ totalRuns: 6, failedRuns: 1, emptyRuns: 1 }))).toBe(
      false,
    );
  });

  it("excludes no-report runs from the denominator (a routine failing every real attempt is flagged)", () => {
    // 6 healthy no-reports + 4 failed → 4/4 real attempts bad. Old (bad/total)
    // math gave 4/10 = 0.4 and wrongly skipped it.
    expect(
      routineNeedsAttention(fakeHealth({ totalRuns: 10, failedRuns: 4, noReportRuns: 6 })),
    ).toBe(true);
  });

  it("is false when there are no real attempts (all no-report)", () => {
    expect(routineNeedsAttention(fakeHealth({ totalRuns: 10, noReportRuns: 10 }))).toBe(false);
  });
});

describe("updateRoutineIfVersion", () => {
  it("applies the edit and bumps version when the expected version matches", async () => {
    const r = await createRoutine("chat-1", baseInput); // version 1
    const updated = await updateRoutineIfVersion(r.id, "chat-1", 1, { prompt: "new prompt" });
    expect(updated).not.toBeNull();
    expect(updated?.prompt).toBe("new prompt");
    expect(updated?.version).toBe(2);
  });

  it("returns null and leaves the routine untouched when the version moved on", async () => {
    const r = await createRoutine("chat-1", baseInput); // version 1
    const res = await updateRoutineIfVersion(r.id, "chat-1", 99, { prompt: "stale" });
    expect(res).toBeNull();
    const after = await getRoutineById(r.id);
    expect(after?.prompt).toBe(baseInput.prompt);
    expect(after?.version).toBe(1);
  });

  it("returns null when the routine does not exist", async () => {
    const res = await updateRoutineIfVersion("000000000000000000000000", "chat-1", 1, {
      enabled: false,
    });
    expect(res).toBeNull();
  });

  it("scopes by chatId", async () => {
    const r = await createRoutine("chat-1", baseInput);
    const res = await updateRoutineIfVersion(r.id, "chat-2", 1, { prompt: "x" });
    expect(res).toBeNull();
  });
});

describe("getRoutineLogs filtering", () => {
  it("excludes composed sub-runs and in-flight rows when asked", async () => {
    const r = await createRoutine("chat-1", baseInput);
    const a = await createRoutineLog(r.id, "cron");
    await completeRoutineLog(a.id, "ok");
    const b = await createRoutineLog(r.id, "routine");
    await completeRoutineLog(b.id, "sub");
    await createRoutineLog(r.id, "cron"); // left running

    expect(await getRoutineLogs(r.id, 50)).toHaveLength(3);

    const filtered = await getRoutineLogs(r.id, 50, {
      excludeComposed: true,
      excludeRunning: true,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.trigger).toBe("cron");
    expect(filtered[0]?.status).toBe("completed");
  });
});
