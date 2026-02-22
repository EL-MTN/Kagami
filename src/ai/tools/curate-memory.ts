import { tool } from "ai";
import { z } from "zod";
import { curateMemories } from "../../memory/curator.js";

export const curateMemory = tool({
  description:
    "Trigger memory curation — summarize and organize stored memories. Only use when explicitly asked or during scheduled maintenance.",
  parameters: z.object({
    scope: z
      .enum(["daily", "weekly"])
      .default("daily")
      .describe("Curation scope: daily summary or weekly deep curation"),
  }),
  execute: async ({ scope }) => {
    await curateMemories(scope);
    return { success: true, scope, message: `${scope} curation completed` };
  },
});
