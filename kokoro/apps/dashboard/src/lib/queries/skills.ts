import { Skill, SkillRevision, type ISkill, type ISkillRevision } from "@kokoro/db";
import { ensureDB } from "../db";
import type { SkillListItem, SkillRevisionItem } from "../skill-schema";

function toSkillListItem(skill: ISkill): SkillListItem {
  return {
    id: skill._id.toString(),
    chatId: skill.chatId,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    triggers: skill.triggers,
    tags: skill.tags,
    enabled: skill.enabled,
    source: skill.source,
    linkedRoutineIds: skill.linkedRoutineIds.map((id) => id.toString()),
    version: skill.version,
    lastUsedAt: skill.lastUsedAt?.toISOString() ?? null,
    usageCount: skill.usageCount,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

export async function getSkillList(): Promise<SkillListItem[]> {
  await ensureDB();
  const skills = await Skill.find().sort({ createdAt: -1 }).limit(200);
  return skills.map(toSkillListItem);
}

export async function getSkillDetail(id: string): Promise<SkillListItem | null> {
  await ensureDB();
  const skill = await Skill.findById(id);
  return skill ? toSkillListItem(skill) : null;
}

function toSkillRevisionItem(revision: ISkillRevision): SkillRevisionItem {
  return {
    version: revision.version,
    name: revision.name,
    description: revision.description,
    body: revision.body,
    triggers: revision.triggers,
    tags: revision.tags,
    reason: revision.reason,
    actor: revision.actor,
    note: revision.note,
    takenAt: revision.takenAt.toISOString(),
  };
}

/** A skill's superseded versions, newest first. The current version lives on
 * the skill itself — the history view composes the two. */
export async function getSkillRevisions(id: string): Promise<SkillRevisionItem[]> {
  await ensureDB();
  const revisions = await SkillRevision.find({ skillId: id }).sort({ version: -1 }).limit(50);
  return revisions.map(toSkillRevisionItem);
}
