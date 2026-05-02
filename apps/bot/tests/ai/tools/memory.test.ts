import { withTestDb } from "@mashiro/test-utils";
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

const { mockRecall, mockRemember, mockSetWorkingMemory, mockCurateIfNeeded } = vi.hoisted(() => ({
  mockRecall: vi.fn(),
  mockRemember: vi.fn(),
  mockSetWorkingMemory: vi.fn(),
  mockCurateIfNeeded: vi.fn(),
}));

vi.mock("@mashiro/memory", () => ({
  recall: mockRecall,
  remember: mockRemember,
  setWorkingMemory: mockSetWorkingMemory,
}));

vi.mock("../../../src/memory/curator", () => ({
  curateIfNeeded: mockCurateIfNeeded,
}));

import { Memory } from "@mashiro/db";
import {
  readMemory,
  searchMemory,
  listMemories,
  rememberFact,
  createNoteToSelfTool,
  createCurateMemoryTool,
} from "../../../src/ai/tools/memory";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockRecall.mockReset();
  mockRemember.mockReset();
  mockSetWorkingMemory.mockReset();
  mockCurateIfNeeded.mockReset();
});

// ─── readMemory ──────────────────────────────────────────────────────────────

describe("readMemory tool", () => {
  const tool = readMemory as unknown as ExecutableTool;

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

// ─── searchMemory ────────────────────────────────────────────────────────────

describe("searchMemory tool", () => {
  const tool = searchMemory as unknown as ExecutableTool;

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

// ─── listMemories ────────────────────────────────────────────────────────────

describe("listMemories tool", () => {
  const tool = listMemories as unknown as ExecutableTool;

  async function seed(
    type: "fact" | "episode" | "milestone" | "working",
    content: string,
    options: {
      createdAt?: Date;
      importance?: number;
      archived?: boolean;
      followUps?: string[];
    } = {},
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

// ─── rememberFact ────────────────────────────────────────────────────────────

describe("rememberFact tool", () => {
  const tool = rememberFact as unknown as ExecutableTool;

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
    expect(mockRemember).toHaveBeenCalledWith("first vacation together", "milestone", "tool", {
      importance: 9,
    });
  });
});

// ─── noteToSelf ──────────────────────────────────────────────────────────────

describe("noteToSelf tool", () => {
  it("calls setWorkingMemory with the configured sessionId", async () => {
    mockSetWorkingMemory.mockResolvedValue({ _id: { toString: () => "n1" } });
    const tool = createNoteToSelfTool("session-abc") as unknown as ExecutableTool;

    const result = await tool.execute({ note: "follow up tomorrow" });

    expect(mockSetWorkingMemory).toHaveBeenCalledWith("follow up tomorrow", "session-abc");
    expect(result).toEqual({
      success: true,
      memoryId: "n1",
      note: "follow up tomorrow",
      expiresIn: "24 hours",
    });
  });

  it("isolates sessions — different factories produce notes scoped to their own session", async () => {
    mockSetWorkingMemory.mockResolvedValue({ _id: { toString: () => "n2" } });
    const a = createNoteToSelfTool("sess-A") as unknown as ExecutableTool;
    const b = createNoteToSelfTool("sess-B") as unknown as ExecutableTool;

    await a.execute({ note: "for A" });
    await b.execute({ note: "for B" });

    expect(mockSetWorkingMemory).toHaveBeenNthCalledWith(1, "for A", "sess-A");
    expect(mockSetWorkingMemory).toHaveBeenNthCalledWith(2, "for B", "sess-B");
  });
});

// ─── curateMemory ────────────────────────────────────────────────────────────

describe("curateMemory tool", () => {
  it("returns immediately and kicks off curation in the background", async () => {
    mockCurateIfNeeded.mockResolvedValue(undefined);
    const tool = createCurateMemoryTool("chat-1") as unknown as ExecutableTool;

    const result = await tool.execute({});

    // Tool returns synchronously without awaiting curateIfNeeded.
    expect(result).toEqual({ success: true, message: "Curation started in background" });
    expect(mockCurateIfNeeded).toHaveBeenCalledWith("chat-1");
  });

  it("does not let a curation rejection escape — the promise is fire-and-forget", async () => {
    // The tool .catch()es the curator's rejection internally so a long-running
    // background failure never throws back to the LLM. Verifying via:
    // - tool resolves successfully, despite curator rejecting
    // - no unhandled rejection escapes (would surface as a test runner crash)
    mockCurateIfNeeded.mockRejectedValue(new Error("background curator died"));
    const tool = createCurateMemoryTool("chat-2") as unknown as ExecutableTool;

    const result = await tool.execute({});
    expect(result).toEqual({ success: true, message: "Curation started in background" });
    // Give the rejected promise's .catch handler a tick to run.
    await new Promise((r) => setImmediate(r));
  });

  it("scopes by chatId — separate factories pass through different ids", async () => {
    mockCurateIfNeeded.mockResolvedValue(undefined);
    const a = createCurateMemoryTool("chat-A") as unknown as ExecutableTool;
    const b = createCurateMemoryTool("chat-B") as unknown as ExecutableTool;

    await a.execute({});
    await b.execute({});

    expect(mockCurateIfNeeded).toHaveBeenNthCalledWith(1, "chat-A");
    expect(mockCurateIfNeeded).toHaveBeenNthCalledWith(2, "chat-B");
  });
});
