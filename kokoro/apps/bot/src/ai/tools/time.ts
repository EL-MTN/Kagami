import { tool } from "ai";
import { z } from "zod";
import { config, logger } from "@kokoro/shared";
import { isoWithOffset } from "../prompts";

/**
 * Fully-local current-time tool — the in-process equivalent of the MCP `time`
 * server (no external process, no network). The user's local date + time-of-day
 * is already ambient in every turn (system prompt) and the precise local clock
 * rides the message tail, so this tool exists for the two cases ambient context
 * can't cover: a FRESH read deep into a long task (the tail time is stamped at
 * turn start and can drift over a multi-minute agentic run), and the time in a
 * DIFFERENT timezone than the user's. IANA/DST handling comes from `Intl`.
 */
export function createGetCurrentTimeTool() {
  return tool({
    description:
      "Get the precise current date and time. Your context already carries the user's local time every turn, so call this only for a fresh read mid-long-task or to get the current time in a DIFFERENT timezone (pass an IANA timezone name).",
    inputSchema: z.object({
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone name, e.g. 'America/New_York', 'Asia/Tokyo', 'Europe/London'. Omit for the user's configured local timezone.",
        ),
    }),
    execute: ({ timezone }) => {
      const tz = timezone ?? config.TIMEZONE;
      const now = new Date();
      try {
        const formatted = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
          hour12: true,
        }).format(now);
        logger.debug({ timezone: tz }, "Tool: getCurrentTime");
        return {
          success: true,
          timezone: tz,
          formatted,
          iso: isoWithOffset(now, tz),
        };
      } catch (error) {
        // An unknown IANA name throws a RangeError at DateTimeFormat construction.
        const reason = error instanceof Error ? error.message : "invalid timezone";
        logger.warn({ error: error, timezone: tz }, "Tool: getCurrentTime failed");
        return { success: false, reason: `Invalid timezone "${tz}": ${reason}` };
      }
    },
  });
}
