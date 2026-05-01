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
import { listMemories } from "../../../src/ai/tools/list-memories";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = listMemories as unknown as ExecutableTool;

async function seed(
  type: "fact" | "episode" | "milestone" | "working",
  content: string,
  options: { createdAt?: Date; importance?: number; archived?: boolean; followUps?: string[] } = {},
) {
  const createdAt = options.createdAt ?? new Date();
  const m = await Memory.create({
    content,
    type,
    source: "test",
    embedding: [],
    metadata: {
      createdAt,
      updatedAt: createdAt,
      importance: options.importance,
      followUps: options.followUps,
      archivedAt: options.archived ? createdAt : undefined,
    },
  });
  return m;
}

describe("listMemories tool", () => {
  it("returns found:false with a message when nothing matches", async () => {
    const result = await tool.execute({ limit: 10 });
    expect(result).toEqual({ found: false, message: "No  memories found" });
  });

  it("excludes archived memories", async () => {
    await seed("fact", "live one");
    await seed("fact", "archived one", { archived: true });
    const result = await tool.execute({ limit: 10 });
    expect(result.found).toBe(true);
    const memories = result.memories as Array<Record<string, unknown>>;
    expect(memories.map((m) => m.preview)).toEqual(["live one"]);
  });

  it("excludes working memory when no type filter is supplied", async () => {
    await seed("fact", "fact one");
    await seed("working", "scratchpad");
    const result = await tool.execute({ limit: 10 });
    const memories = result.memories as Array<Record<string, unknown>>;
    expect(memories.map((m) => m.preview)).toEqual(["fact one"]);
  });

  it("filters by type when supplied", async () => {
    await seed("fact", "a fact");
    await seed("episode", "an episode");
    await seed("milestone", "a milestone");
    const result = await tool.execute({ type: "episode", limit: 10 });
    const memories = result.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(1);
    expect(memories[0]!.type).toBe("episode");
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await seed("fact", `fact ${String(i)}`);
    }
    const result = await tool.execute({ limit: 2 });
    expect(result.count).toBe(2);
  });

  it("orders newest-first by metadata.createdAt", async () => {
    await seed("fact", "older", { createdAt: new Date(Date.now() - 60_000) });
    await seed("fact", "newer", { createdAt: new Date() });
    const result = await tool.execute({ limit: 10 });
    const memories = result.memories as Array<Record<string, unknown>>;
    expect(memories.map((m) => m.preview)).toEqual(["newer", "older"]);
  });

  it("formats date as yyyy-MM-dd and reports hasFollowUps", async () => {
    const createdAt = new Date("2026-04-15T10:00:00Z");
    await seed("episode", "x", { createdAt, followUps: ["check tomorrow"] });
    const result = await tool.execute({ limit: 10 });
    const memories = result.memories as Array<Record<string, unknown>>;
    expect(memories[0]!.date).toBe("2026-04-15");
    expect(memories[0]!.hasFollowUps).toBe(true);
  });

  it("truncates preview to 200 chars", async () => {
    await seed("fact", "x".repeat(300));
    const result = await tool.execute({ limit: 10 });
    const memories = result.memories as Array<Record<string, unknown>>;
    expect((memories[0]!.preview as string).length).toBe(200);
  });
});
