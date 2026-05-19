import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig()),
  config: {
    BROWSER_ENABLED: false,
    KAO_URL: "stub",
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { Watcher, getWatcherById } from "@kokoro/db";
import {
  createManageWatchersTool,
  reportWatcherResult,
  reportWatcherResultInputSchema,
  REPORT_WATCHER_RESULT_TOOL_NAME,
} from "../../../src/ai/tools/watchers";

withTestDb();

interface ExecutableTool {
  execute: (input: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>>;
}

// ─── manageWatchers ──────────────────────────────────────────────────────────

const tool = createManageWatchersTool("chat-1") as unknown as ExecutableTool;

describe("manageWatchers — create", () => {
  it("requires name/description/prompt/cronSchedule", async () => {
    const result = await tool.execute({ action: "create", name: "x" });
    expect(result.success).toBe(false);
    expect(result.reason as string).toMatch(/required to create/);
  });

  it("creates with default 30-day expiry, oneShot=false, no cooldown", async () => {
    const result = await tool.execute({
      action: "create",
      name: "stock",
      description: "watch the price",
      prompt: "check",
      cronSchedule: "*/15 * * * *",
    });
    expect(result.success).toBe(true);
    expect(result.oneShot).toBe(false);
    expect(result.maxFires).toBeNull();
    expect(result.cooldownMs).toBeNull();
    expect(result.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("respects oneShot, maxFires, cooldownMinutes (converted to ms)", async () => {
    const result = await tool.execute({
      action: "create",
      name: "limited",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
      oneShot: true,
      maxFires: 3,
      cooldownMinutes: 30,
    });
    expect(result.oneShot).toBe(true);
    expect(result.maxFires).toBe(3);
    expect(result.cooldownMs).toBe(30 * 60_000);
  });

  it("rejects empty cronSchedule", async () => {
    const result = await tool.execute({
      action: "create",
      name: "blank",
      description: "x",
      prompt: "y",
      cronSchedule: "   ",
    });
    expect(result).toEqual({ success: false, reason: "cronSchedule cannot be empty" });
  });

  it("rejects an invalid cron expression", async () => {
    const result = await tool.execute({
      action: "create",
      name: "badcron",
      description: "x",
      prompt: "y",
      cronSchedule: "not a cron",
    });
    expect(result.reason as string).toMatch(/Invalid cron expression/);
  });

  it("returns a friendly error on duplicate name", async () => {
    await tool.execute({
      action: "create",
      name: "dup",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
    });
    const second = await tool.execute({
      action: "create",
      name: "dup",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
    });
    expect(second).toEqual({ success: false, reason: 'A watcher named "dup" already exists' });
  });
});

describe("manageWatchers — update", () => {
  it("rejects when no fields are supplied", async () => {
    const created = await tool.execute({
      action: "create",
      name: "noop",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
    });
    const result = await tool.execute({
      action: "update",
      watcherId: created.watcherId,
    });
    expect(result).toEqual({ success: false, reason: "No fields supplied to update" });
  });

  it("setting cooldownMinutes=0 clears the cooldown", async () => {
    const created = await tool.execute({
      action: "create",
      name: "cd",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
      cooldownMinutes: 30,
    });
    const watcherId = created.watcherId as string;
    await tool.execute({ action: "update", watcherId, cooldownMinutes: 0 });
    expect((await getWatcherById(watcherId))?.cooldownMs).toBeNull();
  });

  it("re-validates and re-computes nextRunAt when cronSchedule changes", async () => {
    const created = await tool.execute({
      action: "create",
      name: "rc",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
    });
    const watcherId = created.watcherId as string;
    await tool.execute({
      action: "update",
      watcherId,
      cronSchedule: "*/5 * * * *",
    });
    const reloaded = await getWatcherById(watcherId);
    expect(reloaded?.cronSchedule).toBe("*/5 * * * *");
    expect(reloaded?.nextRunAt).toBeInstanceOf(Date);
  });

  it("increments version on update", async () => {
    const created = await tool.execute({
      action: "create",
      name: "ver",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
    });
    const watcherId = created.watcherId as string;
    const updated = await tool.execute({
      action: "update",
      watcherId,
      description: "new desc",
    });
    expect(updated.version).toBe(2);
  });
});

describe("manageWatchers — snooze", () => {
  it("requires watcherId and a positive untilHours", async () => {
    const created = await tool.execute({
      action: "create",
      name: "snz",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
    });
    expect(await tool.execute({ action: "snooze" })).toEqual({
      success: false,
      reason: "watcherId is required for snooze",
    });
    expect(
      await tool.execute({
        action: "snooze",
        watcherId: created.watcherId,
        untilHours: 0,
      }),
    ).toEqual({
      success: false,
      reason: "untilHours (positive finite number) is required for snooze",
    });
  });

  it("sets snoozedUntil ~untilHours from now", async () => {
    const created = await tool.execute({
      action: "create",
      name: "snz2",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
    });
    const before = Date.now();
    await tool.execute({
      action: "snooze",
      watcherId: created.watcherId,
      untilHours: 2,
    });
    const reloaded = await getWatcherById(created.watcherId as string);
    const offset = reloaded!.snoozedUntil!.getTime() - before;
    expect(offset).toBeGreaterThan(2 * 60 * 60 * 1000 - 1000);
    expect(offset).toBeLessThan(2 * 60 * 60 * 1000 + 1000);
  });
});

describe("manageWatchers — delete / enable / disable", () => {
  it("delete + enable + disable all require watcherId; round-trip works", async () => {
    const created = await tool.execute({
      action: "create",
      name: "lifecycle",
      description: "x",
      prompt: "y",
      cronSchedule: "0 * * * *",
    });
    const watcherId = created.watcherId as string;

    await tool.execute({ action: "disable", watcherId });
    expect((await getWatcherById(watcherId))?.enabled).toBe(false);
    await tool.execute({ action: "enable", watcherId });
    expect((await getWatcherById(watcherId))?.enabled).toBe(true);

    await tool.execute({ action: "delete", watcherId });
    expect(await Watcher.findById(watcherId)).toBeNull();
  });
});

// ─── reportWatcherResult ─────────────────────────────────────────────────────

describe("reportWatcherResult tool", () => {
  const reportTool = reportWatcherResult as unknown as ExecutableTool;

  it('exports the canonical tool name as "reportWatcherResult"', () => {
    expect(REPORT_WATCHER_RESULT_TOOL_NAME).toBe("reportWatcherResult");
  });

  it("returns a minimal { ok: true } regardless of input — the executor reads the call args, not the return", async () => {
    const result = await reportTool.execute({
      triggered: true,
      summary: "price dropped",
      newState: "price=99",
    });
    expect(result).toEqual({ ok: true });
  });

  it("input schema requires triggered, summary, newState", () => {
    const missing = reportWatcherResultInputSchema.safeParse({ triggered: true });
    expect(missing.success).toBe(false);

    const ok = reportWatcherResultInputSchema.safeParse({
      triggered: false,
      summary: "no change",
      newState: "price=100",
    });
    expect(ok.success).toBe(true);
  });

  it("input schema rejects non-boolean triggered", () => {
    const result = reportWatcherResultInputSchema.safeParse({
      triggered: "yes",
      summary: "x",
      newState: "y",
    });
    expect(result.success).toBe(false);
  });
});
