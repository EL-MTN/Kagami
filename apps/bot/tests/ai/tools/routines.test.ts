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

const { mockExecuteRoutine } = vi.hoisted(() => ({ mockExecuteRoutine: vi.fn() }));
vi.mock("../../../src/services/routine-executor", () => ({
  // MAX_ROUTINE_DEPTH is the recursion bound — the tool reads it directly.
  MAX_ROUTINE_DEPTH: 3,
  executeRoutine: mockExecuteRoutine,
}));

import { Routine, createRoutine, getRoutineById } from "@mashiro/db";
import {
  createManageRoutinesTool,
  createSearchRoutinesTool,
  createUseRoutineTool,
} from "../../../src/ai/tools/routines";

withTestDb();

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockExecuteRoutine.mockReset();
});

// ─── manageRoutines ──────────────────────────────────────────────────────────

describe("manageRoutines — create", () => {
  const tool = createManageRoutinesTool("chat-1") as unknown as ExecutableTool;

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
  const tool = createManageRoutinesTool("chat-1") as unknown as ExecutableTool;

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
  const tool = createManageRoutinesTool("chat-1") as unknown as ExecutableTool;

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
  const tool = createManageRoutinesTool("chat-1") as unknown as ExecutableTool;

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

// ─── searchRoutines ──────────────────────────────────────────────────────────

describe("searchRoutines tool", () => {
  const tool = createSearchRoutinesTool("chat-1") as unknown as ExecutableTool;

  it("returns hint when no enabled routines exist", async () => {
    const result = await tool.execute({});
    expect(result).toEqual({
      success: true,
      count: 0,
      routines: [],
      hint: "No routines exist yet",
    });
  });

  it("excludes disabled routines", async () => {
    await createRoutine("chat-1", {
      name: "live",
      description: "live routine",
      prompt: "do",
      reportMode: "always",
    });
    const disabled = await createRoutine("chat-1", {
      name: "off",
      description: "disabled routine",
      prompt: "do",
      reportMode: "always",
    });
    await Routine.findByIdAndUpdate(disabled._id, { enabled: false });

    const result = await tool.execute({});
    expect(result.count).toBe(1);
    const routines = result.routines as Array<Record<string, unknown>>;
    expect(routines[0]!.name).toBe("live");
  });

  it("scopes to chatId — same name in another chat is invisible", async () => {
    await createRoutine("chat-1", {
      name: "mine",
      description: "x",
      prompt: "p",
      reportMode: "always",
    });
    await createRoutine("chat-2", {
      name: "theirs",
      description: "y",
      prompt: "p",
      reportMode: "always",
    });
    const result = await tool.execute({});
    const routines = result.routines as Array<Record<string, unknown>>;
    expect(routines.map((s) => s.name)).toEqual(["mine"]);
  });

  it("filters by query terms — case-insensitive, all terms required", async () => {
    await createRoutine("chat-1", {
      name: "summarize-inbox",
      description: "summarize unread emails",
      prompt: "p",
      reportMode: "always",
    });
    await createRoutine("chat-1", {
      name: "weather-check",
      description: "fetch the forecast",
      prompt: "p",
      reportMode: "always",
    });

    const exactName = await tool.execute({ query: "INBOX" });
    expect((exactName.routines as Array<Record<string, unknown>>).map((s) => s.name)).toEqual([
      "summarize-inbox",
    ]);

    const allTerms = await tool.execute({ query: "summarize emails" });
    expect((allTerms.routines as Array<Record<string, unknown>>).map((s) => s.name)).toEqual([
      "summarize-inbox",
    ]);

    const noMatch = await tool.execute({ query: "missing" });
    expect(noMatch.count).toBe(0);
  });

  it("returns parameters and schedule fields in the listing", async () => {
    await createRoutine("chat-1", {
      name: "param-routine",
      description: "test",
      prompt: "p",
      reportMode: "alert",
      cronSchedule: "0 * * * *",
      parameters: [
        { name: "topic", type: "string", description: "what", required: true, default: "news" },
      ],
    });
    const result = await tool.execute({ query: "param" });
    const s = (result.routines as Array<Record<string, unknown>>)[0]!;
    expect(s.cronSchedule).toBe("0 * * * *");
    expect(s.reportMode).toBe("alert");
    expect(s.parameters).toEqual([
      { name: "topic", type: "string", required: true, description: "what" },
    ]);
  });
});

// ─── useRoutine ──────────────────────────────────────────────────────────────

const adapter = fakeAdapter();

async function seedRoutine(
  name: string,
  options: {
    purity?: "read" | "action";
    enabled?: boolean;
    parameters?: Array<{
      name: string;
      type: "string" | "number" | "boolean" | "array" | "object";
      description: string;
      required: boolean;
      default?: unknown;
    }>;
  } = {},
) {
  return createRoutine("chat-1", {
    name,
    description: "x",
    prompt: "y",
    reportMode: "always",
    purity: options.purity ?? "action",
    enabled: options.enabled ?? true,
    parameters: options.parameters ?? [],
  });
}

describe("useRoutine tool — invocation", () => {
  it("delegates to executeRoutine on the happy path", async () => {
    const tool = createUseRoutineTool("chat-1", adapter, 0, "main") as unknown as ExecutableTool;
    await seedRoutine("greet");
    mockExecuteRoutine.mockResolvedValue("hello world");

    const result = await tool.execute({ routineName: "greet" });

    expect(result).toEqual({ success: true, routineName: "greet", result: "hello world" });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(
      expect.objectContaining({
        trigger: "routine",
        depth: 1,
        callingContext: "main",
      }),
    );
  });

  it("returns an error when the routine doesn't exist", async () => {
    const tool = createUseRoutineTool("chat-1", adapter) as unknown as ExecutableTool;
    const result = await tool.execute({ routineName: "missing" });
    expect(result).toEqual({ success: false, reason: 'Routine "missing" not found' });
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
  });

  it("rejects disabled routines", async () => {
    const tool = createUseRoutineTool("chat-1", adapter) as unknown as ExecutableTool;
    const routine = await seedRoutine("off");
    await Routine.findByIdAndUpdate(routine._id, { enabled: false });
    const result = await tool.execute({ routineName: "off" });
    expect(result).toEqual({ success: false, reason: 'Routine "off" is disabled' });
  });

  it("returns an error past MAX_ROUTINE_DEPTH", async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      3, // == MAX_ROUTINE_DEPTH
      "main",
    ) as unknown as ExecutableTool;
    const result = await tool.execute({ routineName: "anything" });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/Maximum routine depth/);
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
  });

  it("propagates depth + 1 to executeRoutine on a deeper hop", async () => {
    const tool = createUseRoutineTool("chat-1", adapter, 1, "main") as unknown as ExecutableTool;
    await seedRoutine("deeper");
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "deeper" });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ depth: 2, callingContext: "main" }));
  });

  it("forwards executor errors as a failed result", async () => {
    const tool = createUseRoutineTool("chat-1", adapter) as unknown as ExecutableTool;
    await seedRoutine("fail");
    mockExecuteRoutine.mockRejectedValue(new Error("LLM 500"));
    const result = await tool.execute({ routineName: "fail" });
    expect(result).toEqual({ success: false, reason: "LLM 500" });
  });
});

describe("useRoutine tool — purity gate (watcher context)", () => {
  it('rejects an action-purity routine when callingContext="watcher"', async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "watcher",
    ) as unknown as ExecutableTool;
    await seedRoutine("act", { purity: "action" });
    const result = await tool.execute({ routineName: "act" });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/has purity "action"/);
    expect(result.reason as string).toMatch(/cannot be invoked from a watcher/);
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
  });

  it('allows a read-purity routine from a watcher and propagates callingContext="watcher"', async () => {
    const tool = createUseRoutineTool(
      "chat-1",
      adapter,
      0,
      "watcher",
    ) as unknown as ExecutableTool;
    await seedRoutine("read-only", { purity: "read" });
    mockExecuteRoutine.mockResolvedValue("watched");
    const result = await tool.execute({ routineName: "read-only" });
    expect(result).toEqual({
      success: true,
      routineName: "read-only",
      result: "watched",
    });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ callingContext: "watcher" }));
  });
});

describe("useRoutine tool — parameter validation", () => {
  it("returns the first parameter error message", async () => {
    const tool = createUseRoutineTool("chat-1", adapter, 0, "main") as unknown as ExecutableTool;
    await seedRoutine("typed", {
      parameters: [{ name: "topic", type: "string", description: "what", required: true }],
    });
    const result = await tool.execute({ routineName: "typed", parameters: {} });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/Parameter "topic"/);
  });

  it("coerces inputs through the param schema before executing", async () => {
    const tool = createUseRoutineTool("chat-1", adapter, 0, "main") as unknown as ExecutableTool;
    await seedRoutine("nums", {
      parameters: [{ name: "n", type: "number", description: "x", required: true }],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "nums", parameters: { n: "42" } });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { n: 42 } }));
  });

  it("stringifies numbers passed for string-typed params (LLM tolerance)", async () => {
    // LLMs occasionally return `42` for a string-typed field; the original
    // hand-rolled validator stringified them. Pin that behavior.
    const tool = createUseRoutineTool("chat-1", adapter, 0, "main") as unknown as ExecutableTool;
    await seedRoutine("topic", {
      parameters: [{ name: "topic", type: "string", description: "x", required: true }],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "topic", parameters: { topic: 42 } });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { topic: "42" } }));
  });

  it("stringifies booleans passed for string-typed params (LLM tolerance)", async () => {
    const tool = createUseRoutineTool("chat-1", adapter, 0, "main") as unknown as ExecutableTool;
    await seedRoutine("flag", {
      parameters: [{ name: "flag", type: "string", description: "x", required: true }],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "flag", parameters: { flag: true } });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { flag: "true" } }));
  });

  it("applies defaults from the routine parameters", async () => {
    const tool = createUseRoutineTool("chat-1", adapter, 0, "main") as unknown as ExecutableTool;
    await seedRoutine("withdef", {
      parameters: [
        {
          name: "topic",
          type: "string",
          description: "x",
          required: true,
          default: "news",
        },
      ],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "withdef", parameters: {} });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { topic: "news" } }));
  });

  it("coerces a non-string default to string for a string-typed param", async () => {
    // Default values stored on a Routine are typed as Mixed in Mongoose, so an
    // LLM can land a number default on a string-typed param. The default must
    // flow through the same coercion as a present value — otherwise the routine
    // executor receives a number where a string is contracted.
    const tool = createUseRoutineTool("chat-1", adapter, 0, "main") as unknown as ExecutableTool;
    await seedRoutine("numdef", {
      parameters: [
        {
          name: "topic",
          type: "string",
          description: "x",
          required: true,
          default: 42,
        },
      ],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "numdef", parameters: {} });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { topic: "42" } }));
  });

  it("coerces a string default to number for a number-typed param", async () => {
    const tool = createUseRoutineTool("chat-1", adapter, 0, "main") as unknown as ExecutableTool;
    await seedRoutine("strdef", {
      parameters: [
        {
          name: "limit",
          type: "number",
          description: "x",
          required: true,
          default: "10",
        },
      ],
    });
    mockExecuteRoutine.mockResolvedValue("ok");
    await tool.execute({ routineName: "strdef", parameters: {} });
    const call = mockExecuteRoutine.mock.calls[0]!;
    expect(call[2]).toEqual(expect.objectContaining({ parameters: { limit: 10 } }));
  });
});
