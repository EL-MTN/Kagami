import { tool } from "ai";
import { z } from "zod";
import {
  listUpcomingEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from "../../services/google-calendar";
import { logger } from "@mashiro/shared";

const isoDatetime = z
  .string()
  .refine((s) => !isNaN(Date.parse(s)), { message: "Must be a valid ISO 8601 datetime" });

export function createManageCalendarTool() {
  return tool({
    description:
      "Manage Goshujin-sama's Google Calendar. List upcoming events, create, update, or delete events.",
    parameters: z.object({
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
