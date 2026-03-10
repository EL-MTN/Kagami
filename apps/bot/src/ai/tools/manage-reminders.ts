import { tool } from "ai";
import { z } from "zod";
import { createReminder, listRemindersForChat, deleteReminder } from "@mashiro/db";
import { logger } from "@mashiro/shared";

export function createManageRemindersTool(chatId: string) {
  return tool({
    description:
      "Manage reminders for Goshujin-sama. Create, list, or delete reminders. Compose the reminder message at creation time — it will be sent as-is when it fires.",
    inputSchema: z.object({
      action: z.enum(["create", "list", "delete"]),
      message: z
        .string()
        .optional()
        .describe("The reminder message to send when it fires (required for create)"),
      fireAt: z
        .string()
        .refine((s) => !isNaN(Date.parse(s)), { message: "Must be a valid ISO 8601 datetime" })
        .optional()
        .describe("When to fire the reminder (ISO 8601, required for create)"),
      reminderId: z.string().optional().describe("Reminder ID for delete action"),
    }),
    execute: async ({ action, message, fireAt, reminderId }) => {
      try {
        switch (action) {
          case "create": {
            if (!message || !fireAt) {
              return {
                success: false,
                reason: "message and fireAt are required to create a reminder",
              };
            }
            logger.info({ chatId, fireAt }, "Tool: manageReminders (create)");
            const reminder = await createReminder(chatId, message, new Date(fireAt));
            return { success: true, reminderId: reminder._id, message, fireAt };
          }

          case "list": {
            logger.info({ chatId }, "Tool: manageReminders (list)");
            const reminders = await listRemindersForChat(chatId);
            return {
              success: true,
              count: reminders.length,
              reminders: reminders.map((r) => ({
                id: r._id,
                message: r.message,
                fireAt: r.fireAt.toISOString(),
              })),
            };
          }

          case "delete": {
            if (!reminderId) {
              return { success: false, reason: "reminderId is required for delete" };
            }
            logger.info({ reminderId }, "Tool: manageReminders (delete)");
            const deleted = await deleteReminder(reminderId);
            return deleted
              ? { success: true, deleted: reminderId }
              : { success: false, reason: "Reminder not found" };
          }
        }
      } catch (error) {
        logger.error({ error, action }, "Tool: manageReminders failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Reminder operation failed",
        };
      }
    },
  });
}
