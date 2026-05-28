import { Conversation, Reminder } from "@kokoro/db";
import { ensureDB } from "../db";

interface OverviewStats {
  totalConversations: number;
  pendingReminders: number;
}

export async function getOverviewStats(): Promise<OverviewStats> {
  await ensureDB();

  const [totalConversations, pendingReminders] = await Promise.all([
    Conversation.countDocuments(),
    Reminder.countDocuments({ fired: false }),
  ]);

  return { totalConversations, pendingReminders };
}

export interface RecentActivityItem {
  id: string;
  summary: string;
  timestamp: Date;
}

export async function getRecentActivity(limit = 10): Promise<RecentActivityItem[]> {
  await ensureDB();

  const recentConvos = await Conversation.find()
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select("_id chatId status messages updatedAt")
    .lean();

  return recentConvos.map((c) => ({
    id: c._id.toString(),
    summary: `${c.status} session — ${c.messages.length} messages`,
    timestamp: c.updatedAt,
  }));
}
