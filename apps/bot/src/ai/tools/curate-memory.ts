import { tool } from "ai";
import { z } from "zod";
import { curateIfNeeded } from "../../memory/curator";
import { logger } from "@mashiro/shared";

export function createCurateMemoryTool(chatId: string) {
  return tool({
    description:
      "Trigger memory curation — summarize and organize overflow messages. Only use when explicitly asked.",
    inputSchema: z.object({}),
    execute: () => {
      void curateIfNeeded(chatId).catch((err) => {
        logger.error({ err, chatId }, "Background curation failed (tool-triggered)");
      });
      return Promise.resolve({ success: true, message: "Curation started in background" });
    },
  });
}
