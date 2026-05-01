import { beforeEach, describe, expect, it, vi } from "vitest";

// Silence the Pino logger.
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

// Mock engine.recall + engine.remember so the tool's logic is testable
// without standing up Mongo for a delegation-only test. Tools that query
// Memory directly (readMemory, listMemories) use withTestDb instead.
const { mockRecall, mockRemember } = vi.hoisted(() => ({
  mockRecall: vi.fn(),
  mockRemember: vi.fn(),
}));
vi.mock("@mashiro/memory", () => ({
  recall: mockRecall,
  remember: mockRemember,
}));

import { rememberFact } from "../../../src/ai/tools/remember-fact";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = rememberFact as unknown as ExecutableTool;

describe("rememberFact tool", () => {
  beforeEach(() => {
    mockRecall.mockReset();
    mockRemember.mockReset();
  });

  it("dedupes against an existing similar fact and returns the existing content", async () => {
    mockRecall.mockResolvedValue([
      { id: "mem-1", content: "Eric prefers oat milk", type: "fact", score: 0.92, metadata: {} },
    ]);

    const result = await tool.execute({
      content: "Eric prefers oat milk",
      type: "fact",
      importance: 5,
    });

    expect(result).toEqual({
      success: false,
      reason: "Similar fact already exists",
      existing: "Eric prefers oat milk",
    });
    expect(mockRecall).toHaveBeenCalledWith("Eric prefers oat milk", {
      type: "fact",
      limit: 1,
      minScore: 0.85,
    });
    expect(mockRemember).not.toHaveBeenCalled();
  });

  it("persists when no duplicate is found and returns the memoryId", async () => {
    mockRecall.mockResolvedValue([]);
    mockRemember.mockResolvedValue({
      _id: { toString: () => "new-id" },
      content: "Eric likes oat milk",
      type: "fact",
    });

    const result = await tool.execute({
      content: "Eric likes oat milk",
      type: "fact",
      importance: 7,
    });

    expect(result).toEqual({
      success: true,
      memoryId: "new-id",
      type: "fact",
      content: "Eric likes oat milk",
      importance: 7,
    });
    expect(mockRemember).toHaveBeenCalledWith("Eric likes oat milk", "fact", "tool", {
      importance: 7,
    });
  });

  it("respects type='milestone' and forwards it to recall + remember", async () => {
    mockRecall.mockResolvedValue([]);
    mockRemember.mockResolvedValue({
      _id: { toString: () => "ms-1" },
      content: "first vacation together",
      type: "milestone",
    });

    await tool.execute({
      content: "first vacation together",
      type: "milestone",
      importance: 9,
    });

    expect(mockRecall).toHaveBeenCalledWith(
      "first vacation together",
      expect.objectContaining({ type: "milestone" }),
    );
    expect(mockRemember).toHaveBeenCalledWith(
      "first vacation together",
      "milestone",
      "tool",
      { importance: 9 },
    );
  });
});
