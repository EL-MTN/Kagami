import { Conversation, Memory, Reminder } from "@mashiro/db";
import { ensureDB } from "../db";

export interface OverviewStats {
  totalConversations: number;
  totalMemories: number;
  totalFacts: number;
  pendingReminders: number;
}

export async function getOverviewStats(): Promise<OverviewStats> {
  await ensureDB();

  const [totalConversations, totalMemories, totalFacts, pendingReminders] = await Promise.all([
    Conversation.countDocuments(),
    Memory.countDocuments(),
    Memory.countDocuments({ type: "fact", "metadata.archivedAt": { $exists: false } }),
    Reminder.countDocuments({ fired: false }),
  ]);

  return { totalConversations, totalMemories, totalFacts, pendingReminders };
}

export interface EmotionalTrendPoint {
  date: string;
  avgTone: number;
  count: number;
}

export async function getEmotionalTrend(days = 14): Promise<EmotionalTrendPoint[]> {
  await ensureDB();

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await Memory.aggregate<EmotionalTrendPoint>([
    {
      $match: {
        "metadata.emotionalTone": { $exists: true },
        "metadata.createdAt": { $gte: cutoff },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$metadata.createdAt" },
        },
        avgTone: { $avg: "$metadata.emotionalTone" },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        date: "$_id",
        avgTone: { $round: ["$avgTone", 2] },
        count: 1,
      },
    },
  ]);

  return result;
}

export interface RecentActivityItem {
  type: "conversation" | "memory";
  id: string;
  summary: string;
  timestamp: Date;
}

export async function getRecentActivity(limit = 10): Promise<RecentActivityItem[]> {
  await ensureDB();

  const [recentConvos, recentMemories] = await Promise.all([
    Conversation.find()
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select("_id chatId status messages updatedAt")
      .lean(),
    Memory.find()
      .sort({ "metadata.createdAt": -1 })
      .limit(limit)
      .select("_id content type metadata.createdAt")
      .lean(),
  ]);

  const items: RecentActivityItem[] = [
    ...recentConvos.map((c) => ({
      type: "conversation" as const,
      id: c._id.toString(),
      summary: `${c.status} session — ${c.messages.length} messages`,
      timestamp: c.updatedAt,
    })),
    ...recentMemories.map((m) => ({
      type: "memory" as const,
      id: m._id.toString(),
      summary: m.content.slice(0, 100) + (m.content.length > 100 ? "..." : ""),
      timestamp: m.metadata.createdAt,
    })),
  ];

  items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return items.slice(0, limit);
}
