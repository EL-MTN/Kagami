import { tool } from "ai";
import { z } from "zod";
import { curateIfNeeded } from "../../memory/curator.js";
import { logger } from "../../utils/logger.js";

export function createCurateMemoryTool(chatId: string) {
  return tool({
    description:
      "Trigger memory curation — summarize and organize overflow messages. Only use when explicitly asked.",
    parameters: z.object({}),
    execute: async () => {
      // Fire-and-forget — don't block the response
      curateIfNeeded(chatId).catch((err) => {
        logger.error({ err, chatId }, "Background curation failed (tool-triggered)");
      });
      return { success: true, message: "Curation started in background" };
    },
  });
}
