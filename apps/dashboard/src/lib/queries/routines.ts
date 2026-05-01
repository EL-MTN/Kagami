import { Routine, RoutineLog, type IRoutineParameter } from "@mashiro/db";
import { ensureDB } from "../db";
import type { RoutineListItem, RoutineLogItem, RoutineParameter } from "../routine-schema";

interface LastLog {
  status: string;
  startedAt: Date;
  completedAt?: Date;
}

interface RoutineDoc {
  _id: { toString(): string };
  chatId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: IRoutineParameter[];
  cronSchedule: string | null;
  reportMode: "always" | "alert";
  purity: "read" | "action";
  enabled: boolean;
  version: number;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeParameter(p: IRoutineParameter): RoutineParameter {
  return {
    name: p.name,
    type: p.type,
    description: p.description,
    required: p.required,
    ...(p.default !== undefined ? { default: p.default } : {}),
  };
}

function toRoutineListItem(s: RoutineDoc, lastLog?: LastLog): RoutineListItem {
  return {
    id: s._id.toString(),
    chatId: s.chatId,
    name: s.name,
    description: s.description,
    prompt: s.prompt,
    parameters: s.parameters.map(serializeParameter),
    cronSchedule: s.cronSchedule,
    reportMode: s.reportMode,
    purity: s.purity ?? "action",
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
}

export async function getRoutineList(): Promise<RoutineListItem[]> {
  await ensureDB();

  const routines = await Routine.find().sort({ createdAt: -1 }).limit(200).lean();

  // Batch-fetch last log for all routines in one query
  const routineIds = routines.map((s) => s._id);
  const lastLogs = await RoutineLog.aggregate<{ _id: unknown; doc: LastLog }>([
    { $match: { routineId: { $in: routineIds } } },
    { $sort: { startedAt: -1 } },
    { $group: { _id: "$routineId", doc: { $first: "$$ROOT" } } },
  ]);
  const lastLogMap = new Map(lastLogs.map((l) => [String(l._id), l.doc]));

  return routines.map((s) => toRoutineListItem(s, lastLogMap.get(s._id.toString())));
}

export async function getRoutineDetail(id: string): Promise<RoutineListItem | null> {
  await ensureDB();

  const s = await Routine.findById(id).lean();
  if (!s) return null;

  const lastLog = await RoutineLog.findOne({ routineId: s._id }).sort({ startedAt: -1 }).lean();
  return toRoutineListItem(s, lastLog ?? undefined);
}

export async function getRoutineLogList(
  routineId: string,
  limit = 50,
  before?: string,
): Promise<{ logs: RoutineLogItem[]; hasMore: boolean }> {
  await ensureDB();

  const filter: Record<string, unknown> = { routineId };
  if (before) {
    filter.startedAt = { $lt: new Date(before) };
  }

  const logs = await RoutineLog.find(filter)
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
