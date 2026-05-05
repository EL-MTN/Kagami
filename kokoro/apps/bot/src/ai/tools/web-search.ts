import { tool } from "ai";
import { z } from "zod";
import { webSearch } from "../../services/web-search";
import { logger } from "@kokoro/shared";

/**
 * Lightweight web search backed by the Brave Search API. No browser, no lock,
 * no LLM extraction — a single HTTP call. Registered when
 * BRAVE_SEARCH_API_KEY is set; otherwise the `search` action on the browse
 * tool covers the fallback path.
 */
export function createWebSearchTool() {
  return tool({
    description:
      "Search the web for current information. Returns a list of results with title, URL, and a short snippet. Use this for quick factual lookups; use `browse` only when you need to actually visit a page, extract structured data, or interact.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Search query"),
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Number of results to return (1–10, default 5)"),
    }),
    execute: async ({ query, count }) => {
      try {
        logger.info({ query, count }, "Tool: webSearch");
        const results = await webSearch(query, { count });
        return { success: true, query, results };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "search failed";
        logger.error({ err: error, query }, "Tool: webSearch failed");
        return { success: false, reason };
      }
    },
  });
}
