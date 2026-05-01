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

import { Memory } from "@mashiro/db";
import { readMemory } from "../../../src/ai/tools/read-memory";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = readMemory as unknown as ExecutableTool;

describe("readMemory tool", () => {
  it("returns found:false with an error when no row matches", async () => {
    const result = await tool.execute({ memoryId: "000000000000000000000000" });
    expect(result).toEqual({
      found: false,
      error: "Memory not found: 000000000000000000000000",
    });
  });

  it("returns the memory's content, type, createdAt, and importance when found", async () => {
    const createdAt = new Date("2026-03-15T12:00:00Z");
    const m = await Memory.create({
      content: "Eric prefers oat milk",
      type: "fact",
      source: "test",
      embedding: [0.1, 0.2, 0.3],
      metadata: { createdAt, updatedAt: createdAt, importance: 7 },
    });

    const result = await tool.execute({ memoryId: m.id as string });

    expect(result).toEqual({
      found: true,
      id: m.id,
      type: "fact",
      content: "Eric prefers oat milk",
      createdAt,
      importance: 7,
    });
  });
});
