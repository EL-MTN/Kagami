import { TokenUsage, type UsageSummary, type DailyUsage } from "@mashiro/db";
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
