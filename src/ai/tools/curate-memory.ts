import { tool } from "ai";
import { z } from "zod";
import { curateIfNeeded } from "../../memory/curator.js";

export function createCurateMemoryTool(chatId: string) {
  return tool({
    description:
      "Trigger memory curation — summarize and organize overflow messages. Only use when explicitly asked.",
    parameters: z.object({}),
    execute: async () => {
      await curateIfNeeded(chatId);
      return { success: true, message: "Curation check completed" };
    },
  });
}
