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

const { mockCurateIfNeeded } = vi.hoisted(() => ({ mockCurateIfNeeded: vi.fn() }));
vi.mock("../../../src/memory/curator", () => ({
  curateIfNeeded: mockCurateIfNeeded,
}));

import { createCurateMemoryTool } from "../../../src/ai/tools/curate-memory";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

describe("curateMemory tool", () => {
  beforeEach(() => {
    mockCurateIfNeeded.mockReset();
  });

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
