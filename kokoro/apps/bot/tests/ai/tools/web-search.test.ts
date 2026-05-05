import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const { mockWebSearch } = vi.hoisted(() => ({ mockWebSearch: vi.fn() }));
vi.mock("../../../src/services/web-search", () => ({
  webSearch: mockWebSearch,
}));

import { createWebSearchTool } from "../../../src/ai/tools/web-search";

interface ExecutableTool {
  execute: (input: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockWebSearch.mockReset();
});

describe("createWebSearchTool", () => {
  it("forwards query and count to the service and wraps results in {success, query, results}", async () => {
    mockWebSearch.mockResolvedValue([{ title: "t", url: "https://x", snippet: "s" }]);
    const tool = createWebSearchTool() as unknown as ExecutableTool;

    const result = await tool.execute({ query: "hello", count: 3 });

    expect(mockWebSearch).toHaveBeenCalledWith("hello", { count: 3 });
    expect(result).toEqual({
      success: true,
      query: "hello",
      results: [{ title: "t", url: "https://x", snippet: "s" }],
    });
  });

  it("returns success:false with the underlying error message when the service throws", async () => {
    mockWebSearch.mockRejectedValue(new Error("Brave search rate limit exceeded (429)"));
    const tool = createWebSearchTool() as unknown as ExecutableTool;

    const result = await tool.execute({ query: "q" });

    expect(result).toEqual({
      success: false,
      reason: "Brave search rate limit exceeded (429)",
    });
  });

  it("uses a default reason when the thrown value isn't an Error", async () => {
    mockWebSearch.mockRejectedValue("not an error");
    const tool = createWebSearchTool() as unknown as ExecutableTool;

    const result = await tool.execute({ query: "q" });

    expect(result).toEqual({ success: false, reason: "search failed" });
  });
});
