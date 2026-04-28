import { tool } from "ai";
import { z } from "zod";
import { logger } from "@mashiro/shared";

export const REPORT_WATCHER_RESULT_TOOL_NAME = "reportWatcherResult";

export interface WatcherResult {
  triggered: boolean;
  summary: string;
  newState: string;
}

export const reportWatcherResultInputSchema = z.object({
  triggered: z
    .boolean()
    .describe(
      "true if the watch condition is now met (or has changed since last state in a way the user cares about); false otherwise",
    ),
  summary: z
    .string()
    .describe("One short paragraph explaining what's new. Sent to the user when triggered=true."),
  newState: z
    .string()
    .describe(
      "Concise snapshot of the current observation. Used as the reference state on the next check. Should capture the data the next run will compare against.",
    ),
});

export const reportWatcherResult = tool({
  description:
    "Report the result of this detection run. Call exactly once when you've gathered enough information. This terminates the watcher tick.",
  inputSchema: reportWatcherResultInputSchema,
  // Output is intentionally minimal — the executor reads the call's input
  // (via `result.steps`), not this return value.
  execute: ({ triggered, summary }) => {
    logger.debug({ triggered, summary }, "Tool: reportWatcherResult");
    return Promise.resolve({ ok: true });
  },
});
