import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it } from "vitest";

import {
  createSkill,
  deleteSkill,
  getSkillByName,
  listEnabledSkillsForChat,
  listSkillsForChat,
  recordSkillUsed,
  resolveSkillRef,
  updateSkill,
} from "../../src/models/skill";

withTestDb();

const baseInput = {
  name: "meeting-followup-style",
  description: "How to write followups after meetings",
  body: "Use concise bullets, include commitments, and end with the next action.",
  triggers: ["after a meeting"],
  tags: ["writing", "followup"],
};

describe("Skill model helpers", () => {
  it("creates and lists skills scoped by chat", async () => {
    const skill = await createSkill("chat-1", baseInput);
    await createSkill("chat-2", baseInput);

    expect(skill.version).toBe(1);
    const chatOne = await listSkillsForChat("chat-1");
    expect(chatOne).toHaveLength(1);
    expect(chatOne[0].name).toBe(baseInput.name);
  });

  it("enforces unique names per chat", async () => {
    await createSkill("chat-1", baseInput);
    await expect(createSkill("chat-1", baseInput)).rejects.toThrow();
    await expect(createSkill("chat-2", baseInput)).resolves.toBeDefined();
  });

  it("lists enabled skills only", async () => {
    await createSkill("chat-1", baseInput);
    await createSkill("chat-1", { ...baseInput, name: "disabled", enabled: false });

    const enabled = await listEnabledSkillsForChat("chat-1");
    expect(enabled.map((skill) => skill.name)).toEqual([baseInput.name]);
  });

  it("resolves by id or name", async () => {
    const skill = await createSkill("chat-1", baseInput);

    await expect(resolveSkillRef("chat-1", skill.id)).resolves.toMatchObject({
      name: baseInput.name,
    });
    await expect(resolveSkillRef("chat-1", baseInput.name)).resolves.toMatchObject({
      id: skill.id,
    });
    await expect(resolveSkillRef("chat-2", baseInput.name)).resolves.toBeNull();
  });

  it("updates fields and records usage", async () => {
    const skill = await createSkill("chat-1", baseInput);
    const updated = await updateSkill(skill.id, { description: "New description", version: 2 });
    expect(updated?.description).toBe("New description");
    expect(updated?.version).toBe(2);

    await recordSkillUsed(skill.id, "chat-1");
    const used = await getSkillByName("chat-1", baseInput.name);
    expect(used?.usageCount).toBe(1);
    expect(used?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("deletes a skill", async () => {
    const skill = await createSkill("chat-1", baseInput);
    expect(await deleteSkill(skill.id, "chat-1")).toBe(true);
    expect(await getSkillByName("chat-1", baseInput.name)).toBeNull();
  });
});
