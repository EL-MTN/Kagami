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

import { Routine, getRoutineById } from "@mashiro/db";
import { createManageRoutinesTool } from "../../../src/ai/tools/manage-routines";

withTestDb();

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = createManageRoutinesTool("chat-1") as unknown as ExecutableTool;

describe("manageRoutines — create", () => {
  it("requires name, description, prompt, reportMode", async () => {
    expect(await tool.execute({ action: "create", name: "x" })).toEqual({
      success: false,
      reason: "name, description, prompt, and reportMode are required to create a routine",
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
    const persisted = await getRoutineById(result.routineId as string);
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
    expect(result.reason as string).toMatch(/Cron-scheduled routines require defaults/);
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
    expect(second).toEqual({ success: false, reason: 'A routine named "dup" already exists' });
  });
});

describe("manageRoutines — list", () => {
  it("returns formatted routine entries scoped to the chat", async () => {
    await tool.execute({
      action: "create",
      name: "a",
      description: "alpha",
      prompt: "p",
      reportMode: "always",
    });
    const result = await tool.execute({ action: "list" });
    expect(result.count).toBe(1);
    const routines = result.routines as Array<Record<string, unknown>>;
    expect(routines[0]!.name).toBe("a");
    expect(routines[0]!.enabled).toBe(true);
    expect(routines[0]!.version).toBe(1);
  });
});

describe("manageRoutines — update", () => {
  it("requires routineId", async () => {
    expect(await tool.execute({ action: "update", description: "x" })).toEqual({
      success: false,
      reason: "routineId is required for update",
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
    const routineId = created.routineId as string;
    const updated = await tool.execute({
      action: "update",
      routineId,
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
    const routineId = created.routineId as string;
    await tool.execute({ action: "update", routineId, cronSchedule: "" });
    const reloaded = await getRoutineById(routineId);
    expect(reloaded?.cronSchedule).toBeNull();
    expect(reloaded?.nextRunAt).toBeNull();
  });

  it("returns 'Routine not found' for an id that doesn't belong to this chat", async () => {
    const result = await tool.execute({
      action: "update",
      routineId: "000000000000000000000000",
      description: "x",
    });
    expect(result).toEqual({ success: false, reason: "Routine not found" });
  });
});

describe("manageRoutines — delete / enable / disable", () => {
  it("delete requires routineId; returns success on existing, fail on missing", async () => {
    expect(await tool.execute({ action: "delete" })).toEqual({
      success: false,
      reason: "routineId is required for delete",
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
      routineId: created.routineId as string,
    });
    expect(ok).toEqual({ success: true, deleted: created.routineId });
    expect(await Routine.findById(created.routineId)).toBeNull();
  });

  it("enable/disable flip the boolean and require routineId", async () => {
    const created = await tool.execute({
      action: "create",
      name: "toggle",
      description: "x",
      prompt: "p",
      reportMode: "always",
    });
    const routineId = created.routineId as string;
    expect(await tool.execute({ action: "disable" })).toEqual({
      success: false,
      reason: "routineId is required for disable",
    });
    await tool.execute({ action: "disable", routineId });
    expect((await getRoutineById(routineId))?.enabled).toBe(false);
    await tool.execute({ action: "enable", routineId });
    expect((await getRoutineById(routineId))?.enabled).toBe(true);
  });
});
