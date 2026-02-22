import { tool } from "ai";
import { z } from "zod";
import { searchVault } from "../../memory/vault.js";
import { logger } from "../../utils/logger.js";

export const searchMemory = tool({
  description:
    "Search across all memory vault files for a keyword or phrase. Use when you need to find information but aren't sure which file contains it.",
  parameters: z.object({
    query: z.string().describe("The search term or phrase to look for"),
  }),
  execute: async ({ query }) => {
    logger.info({ query }, "Tool: searchMemory");
    const results = await searchVault(query);
    logger.debug({ query, resultCount: results.length }, "searchMemory results");
    if (results.length === 0) {
      return { found: false, message: `No results for "${query}"` };
    }
    return {
      found: true,
      results: results.map((r) => ({
        path: r.path,
        matchCount: r.score,
        excerpts: r.matches,
      })),
    };
  },
});
