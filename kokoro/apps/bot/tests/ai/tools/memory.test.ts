import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig<typeof import("@kokoro/shared")>()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const { mockRecall, mockAppendFact } = vi.hoisted(() => ({
  mockRecall: vi.fn(),
  mockAppendFact: vi.fn(),
}));
vi.mock("@kokoro/memory", async (orig) => ({
  ...(await orig<typeof import("@kokoro/memory")>()),
  recall: mockRecall,
  appendFact: mockAppendFact,
}));

import { createSearchMemoryTool, createRememberFactTool } from "../../../src/ai/tools/memory";
import { KiokuClientError } from "@kokoro/memory";

interface ExecutableTool {
  execute: (input: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockRecall.mockReset();
  mockAppendFact.mockReset();
});

describe("searchMemory", () => {
  it("forwards query + k + date filters and wraps the result", async () => {
    mockRecall.mockResolvedValue([
      {
        id: "f1",
        text: "User likes ramen.",
        event_date: "2026-04-15",
        source_session: "s1",
        created_at: "2026-04-15T10:00:00Z",
      },
    ]);

    const tool = createSearchMemoryTool() as unknown as ExecutableTool;
    const result = await tool.execute(
      { query: "food preferences", k: 3, since: "2026-01-01" },
      undefined,
    );

    expect(mockRecall).toHaveBeenCalledWith("food preferences", {
      k: 3,
      since: "2026-01-01",
      until: undefined,
    });
    expect(result).toMatchObject({ success: true, query: "food preferences" });
    expect((result.facts as unknown[]).length).toBe(1);
  });

  it("defaults k to 8 when omitted", async () => {
    mockRecall.mockResolvedValue([]);
    const tool = createSearchMemoryTool() as unknown as ExecutableTool;
    await tool.execute({ query: "anything" }, undefined);
    expect(mockRecall).toHaveBeenCalledWith("anything", {
      k: 8,
      since: undefined,
      until: undefined,
    });
  });

  it("fails open on Kioku errors so the model keeps responding", async () => {
    mockRecall.mockRejectedValue(new KiokuClientError("boom", 503));
    const tool = createSearchMemoryTool() as unknown as ExecutableTool;
    const result = await tool.execute({ query: "x" }, undefined);
    expect(result).toMatchObject({
      success: false,
      degraded: true,
      facts: [],
    });
    expect(typeof result.reason).toBe("string");
  });
});

describe("rememberFact", () => {
  it("forwards text + eventDate and tags the source as rememberFact", async () => {
    mockAppendFact.mockResolvedValue({ id: "new-id", status: "added" });

    const tool = createRememberFactTool() as unknown as ExecutableTool;
    const result = await tool.execute(
      { text: "User just got a cat named Mochi.", eventDate: "2026-04-20" },
      undefined,
    );

    expect(mockAppendFact).toHaveBeenCalledWith({
      text: "User just got a cat named Mochi.",
      event_date: "2026-04-20",
      source_session: "rememberFact",
    });
    expect(result).toMatchObject({
      success: true,
      id: "new-id",
      status: "added",
    });
  });

  it("surfaces the duplicate result on idempotent re-add", async () => {
    mockAppendFact.mockResolvedValue({
      id: "old-id",
      status: "duplicate",
      reason: "hash",
    });

    const tool = createRememberFactTool() as unknown as ExecutableTool;
    const result = await tool.execute({ text: "User likes ramen." }, undefined);
    expect(result).toMatchObject({
      success: true,
      id: "old-id",
      status: "duplicate",
      reason: "hash",
    });
  });

  it("returns a structured error on Kioku failure", async () => {
    mockAppendFact.mockRejectedValue(new Error("network down"));
    const tool = createRememberFactTool() as unknown as ExecutableTool;
    const result = await tool.execute({ text: "x" }, undefined);
    expect(result).toMatchObject({ success: false });
    expect(result.reason).toBe("network down");
  });
});
