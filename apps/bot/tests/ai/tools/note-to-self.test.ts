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

const { mockSetWorkingMemory } = vi.hoisted(() => ({ mockSetWorkingMemory: vi.fn() }));
vi.mock("@mashiro/memory", () => ({ setWorkingMemory: mockSetWorkingMemory }));

import { createNoteToSelfTool } from "../../../src/ai/tools/note-to-self";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

describe("noteToSelf tool", () => {
  beforeEach(() => {
    mockSetWorkingMemory.mockReset();
  });

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
