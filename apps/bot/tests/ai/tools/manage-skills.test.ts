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

import { Skill, getSkillById } from "@mashiro/db";
import { createManageSkillsTool } from "../../../src/ai/tools/manage-skills";

withTestDb();

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = createManageSkillsTool("chat-1") as unknown as ExecutableTool;

describe("manageSkills — create", () => {
  it("requires name, description, prompt, reportMode", async () => {
    expect(await tool.execute({ action: "create", name: "x" })).toEqual({
      success: false,
      reason: "name, description, prompt, and reportMode are required to create a skill",
    });
  });

  it("creates with default purity='action' when omitted", async () => {
    const result = await tool.execute({
      action: "create",
      name: "summarize",
      description: "summarize emails",
      prompt: "do it",
      reportMode: "always",
    });
    expect(result.success).toBe(true);
    expect(result.purity).toBe("action");
    expect(result.cronSchedule).toBeNull();
    expect(result.nextRunAt).toBeNull();
    const persisted = await getSkillById(result.skillId as string);
    expect(persisted?.purity).toBe("action");
  });

  it("respects explicit purity='read'", async () => {
    const result = await tool.execute({
      action: "create",
      name: "search",
      description: "search",
      prompt: "do it",
      reportMode: "alert",
      purity: "read",
    });
    expect(result.purity).toBe("read");
  });

  it("computes nextRunAt when a cronSchedule is supplied", async () => {
    const result = await tool.execute({
      action: "create",
      name: "sch",
      description: "scheduled",
      prompt: "p",
      reportMode: "always",
      cronSchedule: "0 * * * *",
    });
    expect(result.success).toBe(true);
    expect(result.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an invalid cron expression", async () => {
    const result = await tool.execute({
      action: "create",
      name: "bad",
      description: "x",
      prompt: "p",
      reportMode: "always",
      cronSchedule: "not a cron",
    });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/Invalid cron expression/);
  });

  it("rejects a cron schedule whose required params lack defaults", async () => {
    const result = await tool.execute({
      action: "create",
      name: "missing",
      description: "x",
      prompt: "p",
      reportMode: "always",
      cronSchedule: "0 * * * *",
      parameters: [{ name: "topic", type: "string", description: "w", required: true }],
    });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/Cron-scheduled skills require defaults/);
  });

  it("returns a friendly error on duplicate name (unique-index conflict)", async () => {
    await tool.execute({
      action: "create",
      name: "dup",
      description: "x",
      prompt: "p",
      reportMode: "always",
    });
    const second = await tool.execute({
      action: "create",
      name: "dup",
      description: "y",
      prompt: "p",
      reportMode: "always",
    });
    expect(second).toEqual({ success: false, reason: 'A skill named "dup" already exists' });
  });
});

describe("manageSkills — list", () => {
  it("returns formatted skill entries scoped to the chat", async () => {
    await tool.execute({
      action: "create",
      name: "a",
      description: "alpha",
      prompt: "p",
      reportMode: "always",
    });
    const result = await tool.execute({ action: "list" });
    expect(result.count).toBe(1);
    const skills = result.skills as Array<Record<string, unknown>>;
    expect(skills[0]!.name).toBe("a");
    expect(skills[0]!.enabled).toBe(true);
    expect(skills[0]!.version).toBe(1);
  });
});

describe("manageSkills — update", () => {
  it("requires skillId", async () => {
    expect(await tool.execute({ action: "update", description: "x" })).toEqual({
      success: false,
      reason: "skillId is required for update",
    });
  });

  it("increments version on every update", async () => {
    const created = await tool.execute({
      action: "create",
      name: "v",
      description: "x",
      prompt: "p",
      reportMode: "always",
    });
    const skillId = created.skillId as string;
    const updated = await tool.execute({
      action: "update",
      skillId,
      description: "new",
    });
    expect(updated.version).toBe(2);
  });

  it("clears cron + nextRunAt when cronSchedule is set to empty string", async () => {
    const created = await tool.execute({
      action: "create",
      name: "scheduled",
      description: "x",
      prompt: "p",
      reportMode: "always",
      cronSchedule: "0 * * * *",
    });
    const skillId = created.skillId as string;
    await tool.execute({ action: "update", skillId, cronSchedule: "" });
    const reloaded = await getSkillById(skillId);
    expect(reloaded?.cronSchedule).toBeNull();
    expect(reloaded?.nextRunAt).toBeNull();
  });

  it("returns 'Skill not found' for an id that doesn't belong to this chat", async () => {
    const result = await tool.execute({
      action: "update",
      skillId: "000000000000000000000000",
      description: "x",
    });
    expect(result).toEqual({ success: false, reason: "Skill not found" });
  });
});

describe("manageSkills — delete / enable / disable", () => {
  it("delete requires skillId; returns success on existing, fail on missing", async () => {
    expect(await tool.execute({ action: "delete" })).toEqual({
      success: false,
      reason: "skillId is required for delete",
    });
    const created = await tool.execute({
      action: "create",
      name: "to-delete",
      description: "x",
      prompt: "p",
      reportMode: "always",
    });
    const ok = await tool.execute({
      action: "delete",
      skillId: created.skillId as string,
    });
    expect(ok).toEqual({ success: true, deleted: created.skillId });
    expect(await Skill.findById(created.skillId)).toBeNull();
  });

  it("enable/disable flip the boolean and require skillId", async () => {
    const created = await tool.execute({
      action: "create",
      name: "toggle",
      description: "x",
      prompt: "p",
      reportMode: "always",
    });
    const skillId = created.skillId as string;
    expect(await tool.execute({ action: "disable" })).toEqual({
      success: false,
      reason: "skillId is required for disable",
    });
    await tool.execute({ action: "disable", skillId });
    expect((await getSkillById(skillId))?.enabled).toBe(false);
    await tool.execute({ action: "enable", skillId });
    expect((await getSkillById(skillId))?.enabled).toBe(true);
  });
});
