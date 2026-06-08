import { Routine, RoutineLog, MAX_ROUTINE_DEPTH, type IRoutineParameter } from "@kokoro/db";
import { Types } from "mongoose";
import { ensureDB } from "../db";
import type { RoutineListItem, RoutineLogItem, RoutineParameter } from "../routine-schema";

// Bounds the descendant walk for the run tree. A top-level run can spawn
// children at depths 1..MAX_ROUTINE_DEPTH, so that many levels below a root
// covers any legal composition. Sourced from the shared @kokoro/db constant so
// it can't drift from the bot's recursion ceiling.
const MAX_TREE_LEVELS = MAX_ROUTINE_DEPTH;

interface RoutineLogLean {
  _id: { toString(): string };
  routineId: { toString(): string };
  trigger: "cron" | "manual" | "routine";
  parentLogId?: { toString(): string };
  traceId?: string;
  parameters?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  summary?: string;
  startedAt: Date;
  completedAt?: Date;
}

function serializeLog(l: RoutineLogLean, routineName?: string): RoutineLogItem {
  return {
    id: l._id.toString(),
    trigger: l.trigger,
    parentLogId: l.parentLogId?.toString(),
    traceId: l.traceId,
    parameters: l.parameters,
    status: l.status,
    summary: l.summary,
    startedAt: l.startedAt.toISOString(),
    completedAt: l.completedAt?.toISOString(),
    ...(routineName ? { routineName } : {}),
  };
}

/**
 * Attach the descendant run tree to a set of root logs, mutating each root's
 * `children`. Walks `parentLogId` links breadth-first, one query per level
 * (≤ MAX_TREE_LEVELS), batch-resolving routine names since a child run may
 * belong to a different routine than the root. Bounded and N+1-free.
 */
async function attachDescendants(roots: RoutineLogItem[]): Promise<RoutineLogItem[]> {
  if (roots.length === 0) return roots;

  const childrenByParent = new Map<string, RoutineLogItem[]>();
  const nameByRoutineId = new Map<string, string>();
  let frontier = roots.map((r) => r.id);

  for (let level = 0; level < MAX_TREE_LEVELS && frontier.length > 0; level++) {
    const parentIds = frontier.map((id) => new Types.ObjectId(id));
    const docs = await RoutineLog.find({ parentLogId: { $in: parentIds } })
      .sort({ startedAt: 1 })
      .lean<RoutineLogLean[]>();
    if (docs.length === 0) break;

    const missing = [
      ...new Set(
        docs.map((d) => d.routineId.toString()).filter((rid) => !nameByRoutineId.has(rid)),
      ),
    ];
    if (missing.length > 0) {
      const named = await Routine.find({ _id: { $in: missing } })
        .select("name")
        .lean<Array<{ _id: { toString(): string }; name: string }>>();
      for (const r of named) nameByRoutineId.set(r._id.toString(), r.name);
    }

    for (const d of docs) {
      const item = serializeLog(d, nameByRoutineId.get(d.routineId.toString()));
      const parentId = d.parentLogId?.toString();
      if (!parentId) continue;
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(item);
      childrenByParent.set(parentId, siblings);
    }

    frontier = docs.map((d) => d._id.toString());
  }

  // `seen` guards against a malformed parentLogId cycle (data corruption): the
  // BFS above is bounded by level count, but the recursion below would otherwise
  // revisit nodes if the collected edges ever formed a loop.
  const seen = new Set<string>();
  const nest = (item: RoutineLogItem): void => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    const kids = childrenByParent.get(item.id);
    if (kids && kids.length > 0) {
      item.children = kids;
      kids.forEach(nest);
    }
  };
  roots.forEach(nest);

  return roots;
}

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

  // Top-level rows are this routine's OWN runs only — a run that was spawned by
  // another run (parentLogId set, possibly the same routineId via self-
  // composition) appears nested under its parent via attachDescendants, never
  // as a duplicate root. `parentLogId` absent ⇒ true root.
  const filter: Record<string, unknown> = { routineId, parentLogId: { $exists: false } };
  if (before) {
    filter.startedAt = { $lt: new Date(before) };
  }

  const logs = await RoutineLog.find(filter)
    .sort({ startedAt: -1 })
    .limit(limit + 1)
    .lean<RoutineLogLean[]>();

  const hasMore = logs.length > limit;
  const items = logs.slice(0, limit);

  const roots = items.map((l) => serializeLog(l));
  await attachDescendants(roots);

  return { logs: roots, hasMore };
}
