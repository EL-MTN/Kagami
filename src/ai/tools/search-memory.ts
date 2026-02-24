import { tool } from "ai";
import { z } from "zod";
import { searchVault } from "../../memory/vault.js";
import * as engine from "../../memory/engine.js";
import { logger } from "../../utils/logger.js";

export const searchMemory = tool({
  description:
    "Search across all memories using semantic understanding and keyword matching. Finds relevant information even when exact words don't match. Use when you need to find information but aren't sure which file contains it.",
  parameters: z.object({
    query: z.string().describe("The search term, phrase, or question to search for"),
  }),
  execute: async ({ query }) => {
    logger.info({ query }, "Tool: searchMemory (hybrid)");

    // Run semantic and keyword search in parallel
    const [semanticResults, keywordResults] = await Promise.all([
      engine.recall(query, { limit: 10, minScore: 0.3 }).catch((error) => {
        logger.warn({ error }, "Semantic search failed, falling back to keyword only");
        return [];
      }),
      searchVault(query),
    ]);

    // Build a merged results map (dedup by content overlap)
    const seen = new Set<string>();
    const merged: Array<{
      content: string;
      source: string;
      score: number;
      type: string;
    }> = [];

    // Semantic results first (higher quality ranking)
    for (const result of semanticResults) {
      const key = result.content.slice(0, 100).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        content: result.content.slice(0, 500),
        source: result.metadata.vaultPath ?? `memory:${result.type}`,
        score: result.score,
        type: "semantic",
      });
    }

    // Keyword results — boost if also found semantically
    for (const result of keywordResults) {
      const key = result.matches[0]?.slice(0, 100).toLowerCase() ?? result.path;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        content: result.matches.join("\n"),
        source: result.path,
        score: result.score * 0.1, // Normalize keyword scores lower
        type: "keyword",
      });
    }

    // Sort by score descending, take top 10
    merged.sort((a, b) => b.score - a.score);
    const topResults = merged.slice(0, 10);

    logger.debug(
      {
        query,
        semantic: semanticResults.length,
        keyword: keywordResults.length,
        merged: topResults.length,
      },
      "searchMemory hybrid results",
    );

    if (topResults.length === 0) {
      return { found: false, message: `No results for "${query}"` };
    }

    return {
      found: true,
      results: topResults.map((r) => ({
        source: r.source,
        content: r.content,
        score: Math.round(r.score * 100) / 100,
        matchType: r.type,
      })),
    };
  },
});
