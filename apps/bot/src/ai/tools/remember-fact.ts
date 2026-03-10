import { tool } from "ai";
import { z } from "zod";
import * as engine from "@mashiro/memory";
import { logger } from "@mashiro/shared";

export const rememberFact = tool({
  description:
    "Save an important fact or milestone about him directly to your memory. Use for things worth remembering long-term: preferences, life events, important dates, relationship milestones. Don't save trivial things.",
  inputSchema: z.object({
    content: z.string().describe("The fact or milestone to remember"),
    type: z
      .enum(["fact", "milestone"])
      .default("fact")
      .describe(
        "'fact' for user preferences/info, 'milestone' for significant relationship events",
      ),
    importance: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("How important is this? 1=minor detail, 10=life-changing"),
  }),
  execute: async ({ content, type, importance }) => {
    logger.info({ type, importance, contentPreview: content.slice(0, 80) }, "Tool: rememberFact");

    // Check for duplicate facts
    const existing = await engine.recall(content, { type, limit: 1, minScore: 0.85 });
    if (existing.length > 0) {
      logger.info({ existingId: existing[0].id }, "Tool: rememberFact duplicate detected");
      return {
        success: false,
        reason: "Similar fact already exists",
        existing: existing[0].content,
      };
    }

    const memory = await engine.remember(content, type, "tool", { importance });

    return {
      success: true,
      memoryId: memory._id.toString(),
      type,
      content,
      importance,
    };
  },
});
