import { Reminder } from "@mashiro/db";
import { ensureDB } from "../db";

export interface ReminderListItem {
  id: string;
  chatId: string;
  message: string;
  fireAt: Date;
  fired: boolean;
  createdAt: Date;
}

export async function getReminderList(showFired = false): Promise<ReminderListItem[]> {
  await ensureDB();

  const filter = showFired ? {} : { fired: false };

  const items = await Reminder.find(filter).sort({ fireAt: -1 }).limit(100).lean();

  return items.map((r) => ({
    id: r._id.toString(),
    chatId: r.chatId,
    message: r.message,
    fireAt: r.fireAt,
    fired: r.fired,
    createdAt: r.createdAt,
  }));
}
