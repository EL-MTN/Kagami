import { tool } from "ai";
import { z } from "zod";
import * as engine from "@mashiro/memory";
import { logger } from "@mashiro/shared";

export const searchMemory = tool({
  description:
    "Search across all memories using semantic understanding. Finds relevant information even when exact words don't match. Use when you need to find information but aren't sure where it is.",
  parameters: z.object({
    query: z.string().describe("The search term, phrase, or question to search for"),
    type: z
      .enum(["fact", "episode", "milestone"])
      .optional()
      .describe("Optionally filter by memory type"),
  }),
  execute: async ({ query, type }) => {
    logger.info({ query, type }, "Tool: searchMemory");

    const results = await engine.recall(query, { type, limit: 10, minScore: 0.3 });

    logger.debug({ query, resultCount: results.length }, "searchMemory results");

    if (results.length === 0) {
      return { found: false, message: `No results for "${query}"` };
    }

    return {
      found: true,
      results: results.map((r) => ({
        id: r.id,
        source: `memory:${r.type}`,
        content: r.content.slice(0, 500),
        score: Math.round(r.score * 100) / 100,
        type: r.type,
      })),
    };
  },
});
