import { withTestDb } from "@mashiro/test-utils";
import { describe, expect, it } from "vitest";

import {
  Skill,
  SkillLog,
  advanceSkillNextRunAt,
  claimPendingManualRun,
  cleanupOldSkillLogs,
  completeSkillLog,
  createSkill,
  createSkillLog,
  deleteSkill,
  failSkillLog,
  getDueSkills,
  getSkillById,
  getSkillByName,
  getSkillLogs,
  isSkillRunning,
  listSkillsForChat,
  requestManualRun,
  resetStaleRunningSkillLogs,
  updateSkill,
  type SkillInput,
} from "../../src/models/skill";

withTestDb();

const baseInput: SkillInput = {
  name: "summarize-inbox",
  description: "summarize unread emails",
  prompt: "Summarize today's inbox",
  reportMode: "always",
};

describe("createSkill + listSkillsForChat", () => {
  it("creates with purity defaulted to 'action'", async () => {
    const s = await createSkill("chat-1", baseInput);
    expect(s.purity).toBe("action");
    expect(s.enabled).toBe(true);
    expect(s.parameters).toEqual([]);
  });

  it("respects an explicit purity='read'", async () => {
    const s = await createSkill("chat-1", { ...baseInput, purity: "read" });
    expect(s.purity).toBe("read");
  });

  it("rejects duplicate names per chat", async () => {
    await createSkill("chat-1", baseInput);
    await expect(createSkill("chat-1", baseInput)).rejects.toThrow();
  });

  it("permits the same name in a different chat", async () => {
    await createSkill("chat-1", baseInput);
    await expect(createSkill("chat-2", baseInput)).resolves.toBeDefined();
  });

  it("listSkillsForChat returns rows newest-first", async () => {
    const a = await createSkill("chat-1", { ...baseInput, name: "a" });
    // Backdate `a` so the sort by createdAt is deterministic — successive
    // create() calls in tests can land on the same millisecond, which makes
    // the ordering ambiguous.
    await Skill.collection.updateOne(
      { _id: a._id },
      { $set: { createdAt: new Date(Date.now() - 1000) } },
    );
    const b = await createSkill("chat-1", { ...baseInput, name: "b" });
    const rows = await listSkillsForChat("chat-1");
    expect(rows.map((s) => s.id as string)).toEqual([b.id, a.id]);
  });
});

describe("getSkillById / getSkillByName", () => {
  it("getSkillById is chat-scoped when chatId is supplied", async () => {
    const s = await createSkill("chat-1", baseInput);
    expect(await getSkillById(s.id as string, "chat-1")).not.toBeNull();
    expect(await getSkillById(s.id as string, "chat-2")).toBeNull();
  });

  it("getSkillByName returns null for non-matching chat", async () => {
    await createSkill("chat-1", baseInput);
    expect(await getSkillByName("chat-2", baseInput.name)).toBeNull();
  });
});

describe("updateSkill", () => {
  it("patches and returns the new doc", async () => {
    const s = await createSkill("chat-1", baseInput);
    const out = await updateSkill(s.id as string, { description: "new" });
    expect(out?.description).toBe("new");
  });

  it("respects chatId scoping", async () => {
    const s = await createSkill("chat-1", baseInput);
    expect(await updateSkill(s.id as string, { description: "hijack" }, "chat-2")).toBeNull();
  });
});

describe("deleteSkill", () => {
  it("removes skill and cascades to its logs", async () => {
    const s = await createSkill("chat-1", baseInput);
    await createSkillLog(s.id as string, "manual");
    await deleteSkill(s.id as string);
    expect(await Skill.findById(s.id)).toBeNull();
    expect(await SkillLog.countDocuments({ skillId: s._id })).toBe(0);
  });

  it("returns false for a non-existent id", async () => {
    expect(await deleteSkill("000000000000000000000000")).toBe(false);
  });
});

describe("getDueSkills + advanceSkillNextRunAt", () => {
  it("returns enabled rows whose nextRunAt is past and that have a cronSchedule", async () => {
    const due = await createSkill("chat-1", {
      ...baseInput,
      name: "due",
      cronSchedule: "0 * * * *",
      nextRunAt: new Date(Date.now() - 1000),
    });
    await createSkill("chat-1", {
      ...baseInput,
      name: "no-cron",
      nextRunAt: new Date(Date.now() - 1000),
    });
    await createSkill("chat-1", {
      ...baseInput,
      name: "future",
      cronSchedule: "0 * * * *",
      nextRunAt: new Date(Date.now() + 60_000),
    });
    await createSkill("chat-1", {
      ...baseInput,
      name: "disabled",
      cronSchedule: "0 * * * *",
      nextRunAt: new Date(Date.now() - 1000),
      enabled: false,
    });

    const rows = await getDueSkills();
    expect(rows.map((r) => r.id as string)).toEqual([due.id]);
  });

  it("advanceSkillNextRunAt patches nextRunAt", async () => {
    const s = await createSkill("chat-1", { ...baseInput, cronSchedule: "0 * * * *" });
    const target = new Date(Date.now() + 60_000);
    await advanceSkillNextRunAt(s.id as string, target);
    const reloaded = await getSkillById(s.id as string);
    expect(reloaded?.nextRunAt?.getTime()).toBe(target.getTime());
  });
});

describe("manual run lifecycle", () => {
  it("requestManualRun stamps manualRunRequestedAt", async () => {
    const s = await createSkill("chat-1", baseInput);
    const out = await requestManualRun(s.id as string);
    expect(out?.manualRunRequestedAt).toBeInstanceOf(Date);
  });

  it("claimPendingManualRun is atomic — exactly one concurrent claimer wins", async () => {
    const s = await createSkill("chat-1", baseInput);
    await requestManualRun(s.id as string);
    const results = await Promise.all([
      claimPendingManualRun(),
      claimPendingManualRun(),
      claimPendingManualRun(),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const reloaded = await getSkillById(s.id as string);
    expect(reloaded?.manualRunRequestedAt).toBeNull();
  });

  it("claimPendingManualRun ignores disabled rows", async () => {
    const s = await createSkill("chat-1", { ...baseInput, enabled: false });
    await requestManualRun(s.id as string);
    expect(await claimPendingManualRun()).toBeNull();
  });

  it("claimPendingManualRun returns null when nothing is pending", async () => {
    await createSkill("chat-1", baseInput);
    expect(await claimPendingManualRun()).toBeNull();
  });
});

describe("skill logs", () => {
  it("createSkillLog → completeSkillLog roundtrip", async () => {
    const s = await createSkill("chat-1", baseInput);
    const log = await createSkillLog(s.id as string, "cron");
    expect(log.status).toBe("running");
    await completeSkillLog(log.id as string, "ok");
    const [reloaded] = await getSkillLogs(s.id as string);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.summary).toBe("ok");
  });

  it("createSkillLog with parentLogId records the parent reference", async () => {
    const parentSkill = await createSkill("chat-1", { ...baseInput, name: "parent" });
    const childSkill = await createSkill("chat-1", { ...baseInput, name: "child" });
    const parentLog = await createSkillLog(parentSkill.id as string, "manual");
    const childLog = await createSkillLog(childSkill.id as string, "skill", {
      parentLogId: parentLog.id as string,
      parameters: { x: 1 },
    });
    expect(childLog.parentLogId?.toString()).toBe(parentLog._id?.toString());
    expect(childLog.parameters).toEqual({ x: 1 });
  });

  it("failSkillLog records the failure reason", async () => {
    const s = await createSkill("chat-1", baseInput);
    const log = await createSkillLog(s.id as string, "manual");
    await failSkillLog(log.id as string, "boom");
    const [reloaded] = await getSkillLogs(s.id as string);
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.summary).toBe("boom");
  });

  it("isSkillRunning reflects the running window", async () => {
    const s = await createSkill("chat-1", baseInput);
    expect(await isSkillRunning(s.id as string)).toBe(false);
    await createSkillLog(s.id as string, "cron");
    expect(await isSkillRunning(s.id as string)).toBe(true);
  });

  it("isSkillRunning is false past the 15 min stale threshold", async () => {
    const s = await createSkill("chat-1", baseInput);
    const log = await createSkillLog(s.id as string, "cron");
    await SkillLog.collection.updateOne(
      { _id: log._id },
      { $set: { startedAt: new Date(Date.now() - 20 * 60 * 1000) } },
    );
    expect(await isSkillRunning(s.id as string)).toBe(false);
  });

  it("resetStaleRunningSkillLogs flips stale running rows to failed", async () => {
    const s = await createSkill("chat-1", baseInput);
    const fresh = await createSkillLog(s.id as string, "cron");
    const stale = await createSkillLog(s.id as string, "cron");
    await SkillLog.collection.updateOne(
      { _id: stale._id },
      { $set: { startedAt: new Date(Date.now() - 20 * 60 * 1000) } },
    );
    const reset = await resetStaleRunningSkillLogs();
    expect(reset).toBe(1);
    expect((await SkillLog.findById(stale._id))?.status).toBe("failed");
    expect((await SkillLog.findById(fresh._id))?.status).toBe("running");
  });

  it("cleanupOldSkillLogs deletes only non-running old rows", async () => {
    const s = await createSkill("chat-1", baseInput);
    const old = await createSkillLog(s.id as string, "cron");
    await completeSkillLog(old.id as string, "ok");
    await SkillLog.collection.updateOne(
      { _id: old._id },
      { $set: { startedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) } },
    );
    const recent = await createSkillLog(s.id as string, "cron");
    await completeSkillLog(recent.id as string, "ok");
    const removed = await cleanupOldSkillLogs(90);
    expect(removed).toBe(1);
    expect(await SkillLog.findById(old._id)).toBeNull();
    expect(await SkillLog.findById(recent._id)).not.toBeNull();
  });
});
