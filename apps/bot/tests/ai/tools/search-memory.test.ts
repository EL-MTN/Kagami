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

const { mockRecall } = vi.hoisted(() => ({ mockRecall: vi.fn() }));
vi.mock("@mashiro/memory", () => ({ recall: mockRecall }));

import { searchMemory } from "../../../src/ai/tools/search-memory";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = searchMemory as unknown as ExecutableTool;

describe("searchMemory tool", () => {
  beforeEach(() => {
    mockRecall.mockReset();
  });

  it("returns found:false with a message when recall returns nothing", async () => {
    mockRecall.mockResolvedValue([]);
    const result = await tool.execute({ query: "submarines" });
    expect(result).toEqual({ found: false, message: 'No results for "submarines"' });
  });

  it("calls recall with default limit=10 and minScore=0.3", async () => {
    mockRecall.mockResolvedValue([]);
    await tool.execute({ query: "anything" });
    expect(mockRecall).toHaveBeenCalledWith("anything", {
      type: undefined,
      limit: 10,
      minScore: 0.3,
    });
  });

  it("forwards the type filter when supplied", async () => {
    mockRecall.mockResolvedValue([]);
    await tool.execute({ query: "feelings", type: "episode" });
    expect(mockRecall).toHaveBeenCalledWith(
      "feelings",
      expect.objectContaining({ type: "episode" }),
    );
  });

  it("formats results with truncated content, rounded score, and source label", async () => {
    const longContent = "a".repeat(700);
    mockRecall.mockResolvedValue([
      { id: "m1", content: longContent, type: "fact", score: 0.4567, metadata: {} },
      { id: "m2", content: "shorter", type: "episode", score: 0.999, metadata: {} },
    ]);

    const result = await tool.execute({ query: "x" });

    expect(result.found).toBe(true);
    const results = result.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: "m1",
      source: "memory:fact",
      content: "a".repeat(500),
      score: 0.46,
      type: "fact",
    });
    expect(results[1]!.score).toBe(1);
  });
});
