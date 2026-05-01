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

import { Routine, createRoutine } from "@mashiro/db";
import { createSearchRoutinesTool } from "../../../src/ai/tools/search-routines";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = createSearchRoutinesTool("chat-1") as unknown as ExecutableTool;

describe("searchRoutines tool", () => {
  it("returns hint when no enabled routines exist", async () => {
    const result = await tool.execute({});
    expect(result).toEqual({
      success: true,
      count: 0,
      routines: [],
      hint: "No routines exist yet",
    });
  });

  it("excludes disabled routines", async () => {
    await createRoutine("chat-1", {
      name: "live",
      description: "live routine",
      prompt: "do",
      reportMode: "always",
    });
    const disabled = await createRoutine("chat-1", {
      name: "off",
      description: "disabled routine",
      prompt: "do",
      reportMode: "always",
    });
    await Routine.findByIdAndUpdate(disabled._id, { enabled: false });

    const result = await tool.execute({});
    expect(result.count).toBe(1);
    const routines = result.routines as Array<Record<string, unknown>>;
    expect(routines[0]!.name).toBe("live");
  });

  it("scopes to chatId — same name in another chat is invisible", async () => {
    await createRoutine("chat-1", {
      name: "mine",
      description: "x",
      prompt: "p",
      reportMode: "always",
    });
    await createRoutine("chat-2", {
      name: "theirs",
      description: "y",
      prompt: "p",
      reportMode: "always",
    });
    const result = await tool.execute({});
    const routines = result.routines as Array<Record<string, unknown>>;
    expect(routines.map((s) => s.name)).toEqual(["mine"]);
  });

  it("filters by query terms — case-insensitive, all terms required", async () => {
    await createRoutine("chat-1", {
      name: "summarize-inbox",
      description: "summarize unread emails",
      prompt: "p",
      reportMode: "always",
    });
    await createRoutine("chat-1", {
      name: "weather-check",
      description: "fetch the forecast",
      prompt: "p",
      reportMode: "always",
    });

    const exactName = await tool.execute({ query: "INBOX" });
    expect((exactName.routines as Array<Record<string, unknown>>).map((s) => s.name)).toEqual([
      "summarize-inbox",
    ]);

    const allTerms = await tool.execute({ query: "summarize emails" });
    expect((allTerms.routines as Array<Record<string, unknown>>).map((s) => s.name)).toEqual([
      "summarize-inbox",
    ]);

    const noMatch = await tool.execute({ query: "missing" });
    expect(noMatch.count).toBe(0);
  });

  it("returns parameters and schedule fields in the listing", async () => {
    await createRoutine("chat-1", {
      name: "param-routine",
      description: "test",
      prompt: "p",
      reportMode: "alert",
      cronSchedule: "0 * * * *",
      parameters: [
        { name: "topic", type: "string", description: "what", required: true, default: "news" },
      ],
    });
    const result = await tool.execute({ query: "param" });
    const s = (result.routines as Array<Record<string, unknown>>)[0]!;
    expect(s.cronSchedule).toBe("0 * * * *");
    expect(s.reportMode).toBe("alert");
    expect(s.parameters).toEqual([
      { name: "topic", type: "string", required: true, description: "what" },
    ]);
  });
});
