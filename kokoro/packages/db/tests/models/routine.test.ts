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
  getRoutineLogs,
  isRoutineRunning,
  listRoutinesForChat,
  requestManualRun,
  resetStaleRunningRoutineLogs,
  updateRoutine,
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
