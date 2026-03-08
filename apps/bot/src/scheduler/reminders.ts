import { getPendingReminders, markReminderFired } from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";

const POLL_INTERVAL_MS = 60_000; // 1 minute

let interval: NodeJS.Timeout | null = null;

async function firePendingReminders(adapter: PlatformAdapter): Promise<void> {
  try {
    const reminders = await getPendingReminders();
    if (reminders.length === 0) return;

    logger.info({ count: reminders.length }, "Firing pending reminders");

    for (const reminder of reminders) {
      try {
        await adapter.sendText(reminder.chatId, reminder.message);
        await markReminderFired(reminder._id.toString());
        logger.info({ reminderId: reminder._id, chatId: reminder.chatId }, "Reminder fired");
      } catch (error) {
        logger.error({ error, reminderId: reminder._id }, "Failed to fire reminder");
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to poll pending reminders");
  }
}

export function startReminderScheduler(adapter: PlatformAdapter): () => void {
  // Startup recovery: immediately fire any reminders that were due while down
  firePendingReminders(adapter);

  interval = setInterval(() => firePendingReminders(adapter), POLL_INTERVAL_MS);
  interval.unref();

  logger.info("Reminder scheduler started");

  return () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    logger.info("Reminder scheduler stopped");
  };
}
