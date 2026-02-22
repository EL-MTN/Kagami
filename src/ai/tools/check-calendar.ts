import { tool } from "ai";
import { z } from "zod";
import { queryCalendarEvents } from "../../calendar/service.js";

export const checkCalendar = tool({
  description:
    "Look up calendar events by date range or keyword. Use when schedules, dates, plans, or upcoming events come up in conversation.",
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe("Keyword to search for in events"),
    startDate: z
      .string()
      .optional()
      .describe("Start date in YYYY-MM-DD format"),
    endDate: z
      .string()
      .optional()
      .describe("End date in YYYY-MM-DD format"),
  }),
  execute: async ({ query, startDate, endDate }) => {
    const events = await queryCalendarEvents({ query, startDate, endDate });
    if (events.length === 0) {
      return {
        found: false,
        message: "No events found for that query/date range",
      };
    }
    return { found: true, events };
  },
});
