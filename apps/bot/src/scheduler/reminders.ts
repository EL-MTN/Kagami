import { getPendingReminders, markReminderFired } from "@kokoro/db";
import { logger } from "@kokoro/shared";
import { AdapterRegistry, platformForChatId } from "../platform/registry";

const POLL_INTERVAL_MS = 60_000; // 1 minute

let interval: NodeJS.Timeout | null = null;

async function firePendingReminders(registry: AdapterRegistry): Promise<void> {
  try {
    const reminders = await getPendingReminders();
    if (reminders.length === 0) return;

    logger.info({ count: reminders.length }, "Firing pending reminders");

    for (const reminder of reminders) {
      const platform = platformForChatId(reminder.chatId);
      const adapter = registry.get(platform);
      if (!adapter) {
        logger.warn(
          { reminderId: reminder._id, chatId: reminder.chatId, platform },
          "Skipping reminder: adapter not registered",
        );
        continue;
      }
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

export function startReminderScheduler(registry: AdapterRegistry): () => void {
  // Startup recovery: immediately fire any reminders that were due while down
  void firePendingReminders(registry);

  interval = setInterval(() => void firePendingReminders(registry), POLL_INTERVAL_MS);
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
