import { withTestDb } from "@kokoro/test-utils";
import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { createSkill, updateSkillIfVersionWithHistory } from "../../src/models/skill";
import {
  MAX_REVISIONS_PER_SKILL,
  deleteSkillRevisions,
  getSkillRevision,
  listSkillRevisions,
  pruneSkillRevisions,
  snapshotSkillVersion,
} from "../../src/models/skill-revision";

withTestDb();

const baseInput = {
  name: "meeting-followup-style",
  description: "How to write followups after meetings",
  body: "Use concise bullets, include commitments, and end with the next action.",
  triggers: ["after a meeting"],
  tags: ["writing", "followup"],
};

function snapshotInput(skillId: string, version: number, body: string) {
  return {
    skillId,
    chatId: "chat-1",
    version,
    name: "n",
    description: "d",
    body,
    triggers: [],
    tags: [],
  };
}

describe("SkillRevision model", () => {
  it("snapshots are idempotent on (skillId, version) — the first writer wins", async () => {
    const skillId = new Types.ObjectId().toString();
    await snapshotSkillVersion(snapshotInput(skillId, 1, "first"), {
      reason: "refine",
      actor: "curator",
    });
    await snapshotSkillVersion(snapshotInput(skillId, 1, "second"), {
      reason: "merge",
      actor: "curator",
    });

    const revisions = await listSkillRevisions(skillId, "chat-1");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].body).toBe("first");
    expect(revisions[0].reason).toBe("refine");
  });

  it("prunes to the newest MAX_REVISIONS_PER_SKILL", async () => {
    const skillId = new Types.ObjectId().toString();
    const total = MAX_REVISIONS_PER_SKILL + 5;
    for (let version = 1; version <= total; version++) {
      await snapshotSkillVersion(snapshotInput(skillId, version, `body-${version}`), {
        reason: "refine",
        actor: "curator",
      });
    }

    const revisions = await listSkillRevisions(skillId, "chat-1", 100);
    expect(revisions).toHaveLength(MAX_REVISIONS_PER_SKILL);
    expect(revisions[0].version).toBe(total); // newest kept
    expect(revisions[revisions.length - 1].version).toBe(6); // versions 1-5 pruned
  });

  it("prune is a no-op when under the cap", async () => {
    const skillId = new Types.ObjectId().toString();
    await snapshotSkillVersion(snapshotInput(skillId, 1, "a"), {
      reason: "refine",
      actor: "curator",
    });
    await pruneSkillRevisions(skillId, MAX_REVISIONS_PER_SKILL);
    expect(await listSkillRevisions(skillId, "chat-1")).toHaveLength(1);
  });

  it("deleteSkillRevisions clears a skill's history", async () => {
    const skillId = new Types.ObjectId().toString();
    await snapshotSkillVersion(snapshotInput(skillId, 1, "a"), {
      reason: "refine",
      actor: "curator",
    });
    await snapshotSkillVersion(snapshotInput(skillId, 2, "b"), {
      reason: "refine",
      actor: "curator",
    });
    expect(await listSkillRevisions(skillId, "chat-1")).toHaveLength(2);

    await deleteSkillRevisions(skillId);
    expect(await listSkillRevisions(skillId, "chat-1")).toHaveLength(0);
  });
});

describe("updateSkillIfVersionWithHistory", () => {
  it("snapshots the pre-edit content before a content edit, then bumps the version", async () => {
    const skill = await createSkill("chat-1", baseInput);

    const updated = await updateSkillIfVersionWithHistory(
      skill.id,
      "chat-1",
      1,
      { body: "rewritten body" },
      { reason: "refine", actor: "curator", note: "fixed stale guidance" },
    );

    expect(updated?.version).toBe(2);
    expect(updated?.body).toBe("rewritten body");

    const revisions = await listSkillRevisions(skill.id, "chat-1");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].version).toBe(1);
    expect(revisions[0].body).toBe(baseInput.body); // the overwritten content
    expect(revisions[0].reason).toBe("refine");
    expect(revisions[0].actor).toBe("curator");
    expect(revisions[0].note).toBe("fixed stale guidance");
  });

  it("does NOT snapshot an enabled-only (archive) edit", async () => {
    const skill = await createSkill("chat-1", baseInput);

    const disabled = await updateSkillIfVersionWithHistory(
      skill.id,
      "chat-1",
      1,
      { enabled: false },
      { reason: "refine", actor: "curator" },
    );

    expect(disabled?.enabled).toBe(false);
    expect(disabled?.version).toBe(2);
    expect(await listSkillRevisions(skill.id, "chat-1")).toHaveLength(0);
  });

  it("writes no revision when the compare-and-set finds no matching version", async () => {
    const skill = await createSkill("chat-1", baseInput);

    const result = await updateSkillIfVersionWithHistory(
      skill.id,
      "chat-1",
      99, // wrong version
      { body: "x" },
      { reason: "refine", actor: "curator" },
    );

    expect(result).toBeNull();
    expect(await listSkillRevisions(skill.id, "chat-1")).toHaveLength(0);
  });

  it("round-trips a rollback: restoring old content is itself recorded and reversible", async () => {
    const skill = await createSkill("chat-1", baseInput);

    // v1 -> v2 (snapshots v1's content)
    await updateSkillIfVersionWithHistory(
      skill.id,
      "chat-1",
      1,
      { body: "v2 body" },
      { reason: "refine", actor: "curator" },
    );

    const rev1 = await getSkillRevision(skill.id, "chat-1", 1);
    expect(rev1?.body).toBe(baseInput.body);

    // Restore v1's content as v3 (snapshots v2's content under reason "rollback")
    const restored = await updateSkillIfVersionWithHistory(
      skill.id,
      "chat-1",
      2,
      {
        description: rev1!.description,
        body: rev1!.body,
        triggers: rev1!.triggers,
        tags: rev1!.tags,
      },
      { reason: "rollback", actor: "dashboard", note: "Restored v1" },
    );

    expect(restored?.version).toBe(3);
    expect(restored?.body).toBe(baseInput.body);

    const revisions = await listSkillRevisions(skill.id, "chat-1");
    expect(revisions.map((r) => r.version)).toEqual([2, 1]);

    const rev2 = await getSkillRevision(skill.id, "chat-1", 2);
    expect(rev2?.body).toBe("v2 body");
    expect(rev2?.reason).toBe("rollback");
  });
});
