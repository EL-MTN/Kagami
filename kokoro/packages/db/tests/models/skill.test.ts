import { withTestDb } from "@kokoro/test-utils";
import { describe, expect, it } from "vitest";

import {
  createSkill,
  deleteSkill,
  getSkillByName,
  listChatIdsWithSkills,
  listEnabledSkillsForChat,
  listSkillsForChat,
  markSkillsReviewed,
  recordSkillUsed,
  resolveSkillRef,
  skillNeedsReview,
  updateSkill,
  updateSkillIfVersion,
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

describe("updateSkillIfVersion", () => {
  it("applies the patch and bumps the version when the expected version matches", async () => {
    const skill = await createSkill("chat-1", baseInput);

    const updated = await updateSkillIfVersion(skill.id, "chat-1", 1, {
      body: "Rewritten body.",
      description: "Rewritten description",
    });

    expect(updated?.body).toBe("Rewritten body.");
    expect(updated?.description).toBe("Rewritten description");
    expect(updated?.version).toBe(2);
  });

  it("rejects (returns null, writes nothing) on a version mismatch", async () => {
    const skill = await createSkill("chat-1", baseInput);

    const result = await updateSkillIfVersion(skill.id, "chat-1", 99, { body: "clobber" });

    expect(result).toBeNull();
    const current = await getSkillByName("chat-1", baseInput.name);
    expect(current?.body).toBe(baseInput.body);
    expect(current?.version).toBe(1);
  });

  it("is chat-scoped — another chat's id/version never matches", async () => {
    const skill = await createSkill("chat-1", baseInput);
    expect(await updateSkillIfVersion(skill.id, "chat-2", 1, { enabled: false })).toBeNull();
  });

  it("rejects a disabled skill even at the matching version (enable toggles don't bump version)", async () => {
    const skill = await createSkill("chat-1", baseInput);
    // Dashboard-style archive: enabled flips with NO version bump.
    await updateSkill(skill.id, { enabled: false }, "chat-1");

    const result = await updateSkillIfVersion(skill.id, "chat-1", 1, { body: "clobber" });

    expect(result).toBeNull();
    const current = await getSkillByName("chat-1", baseInput.name);
    expect(current?.body).toBe(baseInput.body);
    expect(current?.enabled).toBe(false);
    expect(current?.version).toBe(1);
  });

  it("clears lastReviewedAt — the new version was never reviewed", async () => {
    const skill = await createSkill("chat-1", baseInput);
    await markSkillsReviewed("chat-1", [{ id: skill.id, version: 1 }]);

    const updated = await updateSkillIfVersion(skill.id, "chat-1", 1, { body: "Rewritten." });

    expect(updated?.version).toBe(2);
    expect(updated?.lastReviewedAt).toBeNull();
  });
});

describe("review stamp invalidation on version bumps", () => {
  it("updateSkill clears lastReviewedAt when the patch bumps version (dashboard content edit)", async () => {
    const skill = await createSkill("chat-1", baseInput);
    await markSkillsReviewed("chat-1", [{ id: skill.id, version: 1 }]);

    const updated = await updateSkill(skill.id, { body: "Edited body.", version: 2 }, "chat-1");

    expect(updated?.version).toBe(2);
    expect(updated?.lastReviewedAt).toBeNull();
  });

  it("updateSkill preserves lastReviewedAt on an enabled-only toggle (no version bump)", async () => {
    const skill = await createSkill("chat-1", baseInput);
    const at = new Date("2026-06-01T00:00:00Z");
    await markSkillsReviewed("chat-1", [{ id: skill.id, version: 1 }], at);

    const updated = await updateSkill(skill.id, { enabled: false }, "chat-1");

    expect(updated?.version).toBe(1);
    expect(updated?.lastReviewedAt?.toISOString()).toBe(at.toISOString());
  });
});

describe("skillNeedsReview", () => {
  const now = new Date("2026-06-09T00:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  it("flags a never-reviewed skill regardless of staleness", () => {
    expect(
      skillNeedsReview(
        { enabled: true, createdAt: daysAgo(1), lastUsedAt: daysAgo(0), lastReviewedAt: null },
        now,
      ),
    ).toBe(true);
  });

  it("never flags a disabled skill", () => {
    expect(
      skillNeedsReview(
        { enabled: false, createdAt: daysAgo(400), lastUsedAt: null, lastReviewedAt: null },
        now,
      ),
    ).toBe(false);
  });

  it("flags a reviewed skill again only when stale AND past the review cooldown", () => {
    // Stale (no use in 30d) and cooled down (reviewed >30d ago) → due.
    expect(
      skillNeedsReview(
        {
          enabled: true,
          createdAt: daysAgo(120),
          lastUsedAt: daysAgo(60),
          lastReviewedAt: daysAgo(45),
        },
        now,
      ),
    ).toBe(true);
    // Recently used → not stale → not due, even though the cooldown passed.
    expect(
      skillNeedsReview(
        {
          enabled: true,
          createdAt: daysAgo(120),
          lastUsedAt: daysAgo(3),
          lastReviewedAt: daysAgo(45),
        },
        now,
      ),
    ).toBe(false);
    // Stale but reviewed recently → cooldown holds it back.
    expect(
      skillNeedsReview(
        {
          enabled: true,
          createdAt: daysAgo(120),
          lastUsedAt: daysAgo(60),
          lastReviewedAt: daysAgo(10),
        },
        now,
      ),
    ).toBe(false);
  });

  it("falls back to createdAt for staleness when the skill was never used", () => {
    expect(
      skillNeedsReview(
        { enabled: true, createdAt: daysAgo(60), lastUsedAt: null, lastReviewedAt: daysAgo(45) },
        now,
      ),
    ).toBe(true);
  });
});

describe("markSkillsReviewed", () => {
  it("stamps lastReviewedAt without bumping updatedAt or version", async () => {
    const skill = await createSkill("chat-1", baseInput);
    const before = await getSkillByName("chat-1", baseInput.name);

    const at = new Date("2026-06-09T12:00:00Z");
    await markSkillsReviewed("chat-1", [{ id: skill.id, version: 1 }], at);

    const after = await getSkillByName("chat-1", baseInput.name);
    expect(after?.lastReviewedAt?.toISOString()).toBe(at.toISOString());
    // A review is metadata about the skill, not an edit to it.
    expect(after?.updatedAt.toISOString()).toBe(before?.updatedAt.toISOString());
    expect(after?.version).toBe(1);
  });

  it("is chat-scoped and a no-op for an empty list", async () => {
    const skill = await createSkill("chat-1", baseInput);

    await markSkillsReviewed("chat-2", [{ id: skill.id, version: 1 }]);
    await markSkillsReviewed("chat-1", []);

    const untouched = await getSkillByName("chat-1", baseInput.name);
    expect(untouched?.lastReviewedAt).toBeNull();
  });

  it("skips a skill edited mid-pass — never re-stamps a version it didn't review", async () => {
    const reviewed = await createSkill("chat-1", baseInput);
    const edited = await createSkill("chat-1", { ...baseInput, name: "edited-mid-pass" });
    // The pass read both at v1; this edit lands before the stamp (and clears
    // any prior stamp via the version bump).
    await updateSkill(edited.id, { body: "Edited while the LLM was thinking.", version: 2 });

    await markSkillsReviewed("chat-1", [
      { id: reviewed.id, version: 1 },
      { id: edited.id, version: 1 },
    ]);

    const stamped = await getSkillByName("chat-1", baseInput.name);
    expect(stamped?.lastReviewedAt).toBeInstanceOf(Date);
    const skipped = await getSkillByName("chat-1", "edited-mid-pass");
    // Still unreviewed → due next cycle instead of hidden behind the cooldown.
    expect(skipped?.lastReviewedAt).toBeNull();
  });
});

describe("listChatIdsWithSkills", () => {
  it("returns distinct chatIds owning at least one ENABLED skill", async () => {
    await createSkill("chat-1", baseInput);
    await createSkill("chat-1", { ...baseInput, name: "second-skill" });
    await createSkill("chat-2", { ...baseInput, name: "disabled-only", enabled: false });
    await createSkill("chat-3", baseInput);

    const chatIds = (await listChatIdsWithSkills()).sort();
    expect(chatIds).toEqual(["chat-1", "chat-3"]);
  });
});
