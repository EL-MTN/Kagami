import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it } from "vitest";
import { createSkill, getSkillByName } from "@kokoro/db";

import { createReadSkillTool, createSearchSkillsTool } from "../../../src/ai/tools/skills";

withTestDb();

function runSearch(input: Record<string, unknown>) {
  const t = createSearchSkillsTool("chat-1") as unknown as {
    execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
  };
  return t.execute(input, {});
}

function runRead(input: Record<string, unknown>) {
  const t = createReadSkillTool("chat-1") as unknown as {
    execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
  };
  return t.execute(input, {});
}

describe("searchSkills tool", () => {
  it("lists enabled skills for the current chat without returning full bodies", async () => {
    await createSkill("chat-1", {
      name: "meeting-followup-style",
      description: "Write followups after meetings",
      body: "Use concise bullets and a single next action.",
      triggers: ["after a meeting"],
      tags: ["writing"],
    });
    await createSkill("chat-1", {
      name: "disabled-skill",
      description: "Hidden",
      body: "Hidden body",
      enabled: false,
    });
    await createSkill("chat-2", {
      name: "other-chat",
      description: "Other",
      body: "Other body",
    });

    const result = await runSearch({});

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    const skills = result.skills as Array<Record<string, unknown>>;
    expect(skills).toEqual([
      expect.objectContaining({
        name: "meeting-followup-style",
        description: "Write followups after meetings",
        triggers: ["after a meeting"],
        tags: ["writing"],
      }),
    ]);
    expect(JSON.stringify(skills)).not.toContain("Use concise bullets");
  });

  it("matches query terms against description, triggers, tags, and body", async () => {
    await createSkill("chat-1", {
      name: "meeting-followup-style",
      description: "Write followups after meetings",
      body: "Include commitments.",
      triggers: ["after a meeting"],
      tags: ["writing"],
    });
    await createSkill("chat-1", {
      name: "contract-review",
      description: "Review legal docs",
      body: "Check indemnity.",
      tags: ["legal"],
    });

    const result = await runSearch({ query: "commitments" });
    expect(result.count).toBe(1);
    expect(result.skills as Array<Record<string, unknown>>).toEqual([
      expect.objectContaining({ name: "meeting-followup-style" }),
    ]);
  });
});

describe("readSkill tool", () => {
  it("returns the full skill body and increments usage", async () => {
    await createSkill("chat-1", {
      name: "meeting-followup-style",
      description: "Write followups after meetings",
      body: "Use concise bullets and a single next action.",
    });

    const result = await runRead({ name: "meeting-followup-style" });

    expect(result.success).toBe(true);
    expect(result.skill as Record<string, unknown>).toEqual(
      expect.objectContaining({
        name: "meeting-followup-style",
        body: "Use concise bullets and a single next action.",
      }),
    );
    const skill = await getSkillByName("chat-1", "meeting-followup-style");
    expect(skill?.usageCount).toBe(1);
    expect(skill?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("does not read disabled skills", async () => {
    await createSkill("chat-1", {
      name: "disabled-skill",
      description: "Hidden",
      body: "Hidden body",
      enabled: false,
    });

    const result = await runRead({ name: "disabled-skill" });
    expect(result.success).toBe(false);
  });
});
