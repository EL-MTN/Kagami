import { TokenUsage, Routine, Watcher, type UsageSummary, type DailyUsage } from "@kokoro/db";
import { Types } from "mongoose";
import { ensureDB } from "../db";

export interface UsageOverview {
  todayCost: number;
  weekCost: number;
  monthCost: number;
  totalTokens: number;
}

export async function getUsageOverview(): Promise<UsageOverview> {
  await ensureDB();

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [todayResult, weekResult, monthResult, tokenResult] = await Promise.all([
    TokenUsage.aggregate<{ total: number }>([
      { $match: { timestamp: { $gte: startOfDay } } },
      { $group: { _id: null, total: { $sum: "$estimatedCost" } } },
    ]),
    TokenUsage.aggregate<{ total: number }>([
      { $match: { timestamp: { $gte: startOfWeek } } },
      { $group: { _id: null, total: { $sum: "$estimatedCost" } } },
    ]),
    TokenUsage.aggregate<{ total: number }>([
      { $match: { timestamp: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$estimatedCost" } } },
    ]),
    TokenUsage.aggregate<{ total: number }>([
      { $group: { _id: null, total: { $sum: "$totalTokens" } } },
    ]),
  ]);

  return {
    todayCost: todayResult[0]?.total ?? 0,
    weekCost: weekResult[0]?.total ?? 0,
    monthCost: monthResult[0]?.total ?? 0,
    totalTokens: tokenResult[0]?.total ?? 0,
  };
}

export async function getUsageByCategory(days = 30): Promise<UsageSummary[]> {
  await ensureDB();

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return TokenUsage.aggregate<UsageSummary>([
    { $match: { timestamp: { $gte: cutoff } } },
    {
      $group: {
        _id: "$category",
        totalPromptTokens: { $sum: "$promptTokens" },
        totalCompletionTokens: { $sum: "$completionTokens" },
        totalTokens: { $sum: "$totalTokens" },
        totalCost: { $sum: "$estimatedCost" },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        category: "$_id",
        totalPromptTokens: 1,
        totalCompletionTokens: 1,
        totalTokens: 1,
        totalCost: { $round: ["$totalCost", 6] },
        count: 1,
      },
    },
    { $sort: { totalCost: -1 } },
  ]);
}

export interface OriginUsage {
  id: string;
  name: string;
  totalCost: number;
  totalTokens: number;
  count: number;
}

interface OriginAggResult {
  _id: string;
  totalCost: number;
  totalTokens: number;
  count: number;
}

async function aggregateByOrigin(
  metadataField: "routineId" | "watcherId",
  days: number,
): Promise<OriginAggResult[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const matchField = `metadata.${metadataField}`;

  return TokenUsage.aggregate<OriginAggResult>([
    {
      $match: {
        timestamp: { $gte: cutoff },
        [matchField]: { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: `$${matchField}`,
        totalCost: { $sum: "$estimatedCost" },
        totalTokens: { $sum: "$totalTokens" },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 1,
        totalCost: { $round: ["$totalCost", 6] },
        totalTokens: 1,
        count: 1,
      },
    },
    { $sort: { totalCost: -1 } },
    { $limit: 20 },
  ]);
}

function toObjectIds(ids: string[]): Types.ObjectId[] {
  const out: Types.ObjectId[] = [];
  for (const id of ids) {
    if (Types.ObjectId.isValid(id)) out.push(new Types.ObjectId(id));
  }
  return out;
}

export async function getUsageByRoutine(days = 30): Promise<OriginUsage[]> {
  await ensureDB();
  const rows = await aggregateByOrigin("routineId", days);
  if (rows.length === 0) return [];

  const ids = toObjectIds(rows.map((r) => r._id));
  const routines = await Routine.find({ _id: { $in: ids } })
    .select("_id name")
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  const nameById = new Map(routines.map((s) => [s._id.toString(), s.name]));

  return rows.map((r) => ({
    id: r._id,
    name: nameById.get(r._id) ?? "(deleted)",
    totalCost: r.totalCost,
    totalTokens: r.totalTokens,
    count: r.count,
  }));
}

export async function getUsageByWatcher(days = 30): Promise<OriginUsage[]> {
  await ensureDB();
  const rows = await aggregateByOrigin("watcherId", days);
  if (rows.length === 0) return [];

  const ids = toObjectIds(rows.map((r) => r._id));
  const watchers = await Watcher.find({ _id: { $in: ids } })
    .select("_id name")
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  const nameById = new Map(watchers.map((w) => [w._id.toString(), w.name]));

  return rows.map((r) => ({
    id: r._id,
    name: nameById.get(r._id) ?? "(deleted)",
    totalCost: r.totalCost,
    totalTokens: r.totalTokens,
    count: r.count,
  }));
}

export async function getDailyUsageTrend(days = 30): Promise<DailyUsage[]> {
  await ensureDB();

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return TokenUsage.aggregate<DailyUsage>([
    { $match: { timestamp: { $gte: cutoff } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
        totalTokens: { $sum: "$totalTokens" },
        totalCost: { $sum: "$estimatedCost" },
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        date: "$_id",
        totalTokens: 1,
        totalCost: { $round: ["$totalCost", 6] },
        count: 1,
      },
    },
    { $sort: { date: 1 } },
  ]);
}
