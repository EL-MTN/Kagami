import { Skill, SkillLog } from "@mashiro/db";
import { ensureDB } from "../db";
import type { SkillListItem, SkillLogItem } from "../skill-schema";

export async function getSkillList(): Promise<SkillListItem[]> {
  await ensureDB();

  const skills = await Skill.find().sort({ createdAt: -1 }).limit(200).lean();

  // Batch-fetch last log for all skills in one query
  const skillIds = skills.map((s) => s._id);
  const lastLogs = await SkillLog.aggregate<{
    _id: unknown;
    doc: { status: string; startedAt: Date; completedAt?: Date };
  }>([
    { $match: { skillId: { $in: skillIds } } },
    { $sort: { startedAt: -1 } },
    { $group: { _id: "$skillId", doc: { $first: "$$ROOT" } } },
  ]);
  const lastLogMap = new Map(lastLogs.map((l) => [String(l._id), l.doc]));

  return skills.map((s) => {
    const lastLog = lastLogMap.get(s._id.toString());
    return {
      id: s._id.toString(),
      chatId: s.chatId,
      name: s.name,
      description: s.description,
      prompt: s.prompt,
      parameters: s.parameters.map((p) => ({
        name: p.name,
        type: p.type,
        description: p.description,
        required: p.required,
        ...(p.default !== undefined ? { default: p.default } : {}),
      })),
      cronSchedule: s.cronSchedule,
      reportMode: s.reportMode,
      enabled: s.enabled,
      version: s.version,
      nextRunAt: s.nextRunAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      lastRun: lastLog
        ? {
            status: lastLog.status as "running" | "completed" | "failed",
            startedAt: lastLog.startedAt.toISOString(),
            completedAt: lastLog.completedAt?.toISOString(),
          }
        : undefined,
    };
  });
}

export async function getSkillDetail(id: string): Promise<SkillListItem | null> {
  await ensureDB();

  const s = await Skill.findById(id).lean();
  if (!s) return null;

  // Get last log for this skill
  const lastLog = await SkillLog.findOne({ skillId: s._id }).sort({ startedAt: -1 }).lean();

  return {
    id: s._id.toString(),
    chatId: s.chatId,
    name: s.name,
    description: s.description,
    prompt: s.prompt,
    parameters: s.parameters.map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      required: p.required,
      ...(p.default !== undefined ? { default: p.default } : {}),
    })),
    cronSchedule: s.cronSchedule,
    reportMode: s.reportMode,
    enabled: s.enabled,
    version: s.version,
    nextRunAt: s.nextRunAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    lastRun: lastLog
      ? {
          status: lastLog.status,
          startedAt: lastLog.startedAt.toISOString(),
          completedAt: lastLog.completedAt?.toISOString(),
        }
      : undefined,
  };
}

export async function getSkillLogList(
  skillId: string,
  limit = 50,
  before?: string,
): Promise<{ logs: SkillLogItem[]; hasMore: boolean }> {
  await ensureDB();

  const filter: Record<string, unknown> = { skillId };
  if (before) {
    filter.startedAt = { $lt: new Date(before) };
  }

  const logs = await SkillLog.find(filter)
    .sort({ startedAt: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = logs.length > limit;
  const items = logs.slice(0, limit);

  return {
    logs: items.map((l) => ({
      id: l._id.toString(),
      trigger: l.trigger,
      parentLogId: l.parentLogId?.toString(),
      parameters: l.parameters,
      status: l.status,
      summary: l.summary,
      startedAt: l.startedAt.toISOString(),
      completedAt: l.completedAt?.toISOString(),
    })),
    hasMore,
  };
}
