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

import {
  REPORT_WATCHER_RESULT_TOOL_NAME,
  reportWatcherResult,
  reportWatcherResultInputSchema,
} from "../../../src/ai/tools/report-watcher-result";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = reportWatcherResult as unknown as ExecutableTool;

describe("reportWatcherResult tool", () => {
  it('exports the canonical tool name as "reportWatcherResult"', () => {
    expect(REPORT_WATCHER_RESULT_TOOL_NAME).toBe("reportWatcherResult");
  });

  it("returns a minimal { ok: true } regardless of input — the executor reads the call args, not the return", async () => {
    const result = await tool.execute({
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
