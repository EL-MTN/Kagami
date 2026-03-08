import { tool } from "ai";
import { z } from "zod";
import { format } from "date-fns";
import { Memory } from "../../db/models/memory.js";
import { logger } from "../../utils/logger.js";

export const listMemories = tool({
  description:
    "List available memories by type. Use to discover past conversation summaries, stored facts, or milestones. Helpful when you want to see what you remember.",
  parameters: z.object({
    type: z
      .enum(["fact", "episode", "milestone"])
      .optional()
      .describe(
        "Filter by memory type. 'episode' = conversation summaries, 'fact' = user facts, 'milestone' = relationship milestones. Omit for all types.",
      ),
    limit: z.number().default(10).describe("Maximum number of results to return"),
  }),
  execute: async ({ type, limit }) => {
    logger.info({ type, limit }, "Tool: listMemories");

    const filter: Record<string, unknown> = {
      "metadata.archivedAt": { $exists: false },
    };
    if (type) {
      filter.type = type;
    } else {
      // Exclude working memory from general listing
      filter.type = { $ne: "working" };
    }

    const memories = await Memory.find(filter)
      .sort({ "metadata.createdAt": -1 })
      .limit(limit)
      .select("content type metadata.createdAt metadata.importance metadata.followUps")
      .exec();

    if (memories.length === 0) {
      return { found: false, message: `No ${type ?? ""} memories found` };
    }

    return {
      found: true,
      count: memories.length,
      memories: memories.map((m) => ({
        id: m._id.toString(),
        type: m.type,
        date: format(m.metadata.createdAt, "yyyy-MM-dd"),
        preview: m.content.slice(0, 200),
        importance: m.metadata.importance,
        hasFollowUps: (m.metadata.followUps?.length ?? 0) > 0,
      })),
    };
  },
});
