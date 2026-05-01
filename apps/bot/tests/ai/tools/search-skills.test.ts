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

import { Skill, createSkill } from "@mashiro/db";
import { createSearchSkillsTool } from "../../../src/ai/tools/search-skills";

withTestDb({ syncIndexes: false });

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = createSearchSkillsTool("chat-1") as unknown as ExecutableTool;

describe("searchSkills tool", () => {
  it("returns hint when no enabled skills exist", async () => {
    const result = await tool.execute({});
    expect(result).toEqual({
      success: true,
      count: 0,
      skills: [],
      hint: "No skills exist yet",
    });
  });

  it("excludes disabled skills", async () => {
    await createSkill("chat-1", {
      name: "live",
      description: "live skill",
      prompt: "do",
      reportMode: "always",
    });
    const disabled = await createSkill("chat-1", {
      name: "off",
      description: "disabled skill",
      prompt: "do",
      reportMode: "always",
    });
    await Skill.findByIdAndUpdate(disabled._id, { enabled: false });

    const result = await tool.execute({});
    expect(result.count).toBe(1);
    const skills = result.skills as Array<Record<string, unknown>>;
    expect(skills[0]!.name).toBe("live");
  });

  it("scopes to chatId — same name in another chat is invisible", async () => {
    await createSkill("chat-1", {
      name: "mine",
      description: "x",
      prompt: "p",
      reportMode: "always",
    });
    await createSkill("chat-2", {
      name: "theirs",
      description: "y",
      prompt: "p",
      reportMode: "always",
    });
    const result = await tool.execute({});
    const skills = result.skills as Array<Record<string, unknown>>;
    expect(skills.map((s) => s.name)).toEqual(["mine"]);
  });

  it("filters by query terms — case-insensitive, all terms required", async () => {
    await createSkill("chat-1", {
      name: "summarize-inbox",
      description: "summarize unread emails",
      prompt: "p",
      reportMode: "always",
    });
    await createSkill("chat-1", {
      name: "weather-check",
      description: "fetch the forecast",
      prompt: "p",
      reportMode: "always",
    });

    const exactName = await tool.execute({ query: "INBOX" });
    expect((exactName.skills as Array<Record<string, unknown>>).map((s) => s.name)).toEqual([
      "summarize-inbox",
    ]);

    const allTerms = await tool.execute({ query: "summarize emails" });
    expect((allTerms.skills as Array<Record<string, unknown>>).map((s) => s.name)).toEqual([
      "summarize-inbox",
    ]);

    const noMatch = await tool.execute({ query: "missing" });
    expect(noMatch.count).toBe(0);
  });

  it("returns parameters and schedule fields in the listing", async () => {
    await createSkill("chat-1", {
      name: "param-skill",
      description: "test",
      prompt: "p",
      reportMode: "alert",
      cronSchedule: "0 * * * *",
      parameters: [
        { name: "topic", type: "string", description: "what", required: true, default: "news" },
      ],
    });
    const result = await tool.execute({ query: "param" });
    const s = (result.skills as Array<Record<string, unknown>>)[0]!;
    expect(s.cronSchedule).toBe("0 * * * *");
    expect(s.reportMode).toBe("alert");
    expect(s.parameters).toEqual([
      { name: "topic", type: "string", required: true, description: "what" },
    ]);
  });
});
