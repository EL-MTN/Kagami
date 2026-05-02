import { tool } from "ai";
import { z } from "zod";
import {
  listUpcomingEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from "../../services/google-calendar";
import { createReminder, listRemindersForChat, deleteReminder } from "@mashiro/db";
import { logger } from "@mashiro/shared";

const isoDatetime = z
  .string()
  .refine((s) => !isNaN(Date.parse(s)), { message: "Must be a valid ISO 8601 datetime" });

// ─── manageCalendar ──────────────────────────────────────────────────────────

export interface ManageCalendarToolOptions {
  /** "full" exposes list/create/update/delete; "readOnly" restricts to list. */
  mode?: "full" | "readOnly";
}

function createListCalendarTool() {
  return tool({
    description: "List upcoming events on Goshujin-sama's Google Calendar.",
    inputSchema: z.object({
      daysAhead: z.number().optional().describe("Number of days ahead to list events (default 7)"),
      maxResults: z.number().optional().describe("Maximum number of events to return (default 10)"),
    }),
    execute: async ({ daysAhead, maxResults }) => {
      try {
        logger.info({ daysAhead, maxResults }, "Tool: listCalendarEvents");
        const events = await listUpcomingEvents(daysAhead, maxResults);
        return { success: true as const, count: events.length, events };
      } catch (error) {
        logger.error({ error }, "Tool: listCalendarEvents failed");
        return {
          success: false as const,
          reason: error instanceof Error ? error.message : "Calendar list failed",
        };
      }
    },
  });
}

export function createManageCalendarTool(options: ManageCalendarToolOptions = {}) {
  if (options.mode === "readOnly") {
    return createListCalendarTool();
  }

  return tool({
    description:
      "Manage Goshujin-sama's Google Calendar. List upcoming events, create, update, or delete events.",
    inputSchema: z.object({
      action: z.enum(["list", "create", "update", "delete"]),
      daysAhead: z.number().optional().describe("Number of days ahead to list events (default 7)"),
      maxResults: z.number().optional().describe("Maximum number of events to return (default 10)"),
      eventId: z.string().optional().describe("Event ID for update/delete actions"),
      summary: z.string().optional().describe("Event title"),
      description: z.string().optional().describe("Event description"),
      start: isoDatetime.optional().describe("Event start time (ISO 8601)"),
      end: isoDatetime.optional().describe("Event end time (ISO 8601)"),
      location: z.string().optional().describe("Event location"),
    }),
    execute: async ({
      action,
      daysAhead,
      maxResults,
      eventId,
      summary,
      description,
      start,
      end,
      location,
    }) => {
      try {
        switch (action) {
          case "list": {
            logger.info({ daysAhead, maxResults }, "Tool: manageCalendar (list)");
            const events = await listUpcomingEvents(daysAhead, maxResults);
            return { success: true, count: events.length, events };
          }

          case "create": {
            if (!summary || !start || !end) {
              return {
                success: false,
                reason: "summary, start, and end are required to create an event",
              };
            }
            logger.info({ summary, start, end }, "Tool: manageCalendar (create)");
            const event = await createEvent({ summary, description, start, end, location });
            return { success: true, event };
          }

          case "update": {
            if (!eventId) {
              return { success: false, reason: "eventId is required for update" };
            }
            logger.info({ eventId }, "Tool: manageCalendar (update)");
            const updated = await updateEvent(eventId, {
              summary,
              description,
              start,
              end,
              location,
            });
            return { success: true, event: updated };
          }

          case "delete": {
            if (!eventId) {
              return { success: false, reason: "eventId is required for delete" };
            }
            logger.info({ eventId }, "Tool: manageCalendar (delete)");
            await deleteEvent(eventId);
            return { success: true, deleted: eventId };
          }
        }
      } catch (error) {
        logger.error({ error, action }, "Tool: manageCalendar failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Calendar operation failed",
        };
      }
    },
  });
}

// ─── manageReminders ─────────────────────────────────────────────────────────

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
      fireAt: isoDatetime
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
