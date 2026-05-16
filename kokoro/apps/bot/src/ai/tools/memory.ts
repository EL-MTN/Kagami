import { tool } from "ai";
import { z } from "zod";
import { logger } from "@kokoro/shared";
import { recall, appendFactWithRetryQueue, KiokuClientError } from "@kokoro/memory";

/**
 * Memory retrieval tool. Calls Kioku's hybrid ranker (cosine + BM25 +
 * entity boost) and returns the top-K atomic facts directly — no
 * answerer LLM, no synthesis. The model reads the facts and reasons over
 * them itself.
 *
 * Fails open: a Kioku outage returns an empty fact list with `degraded:
 * true` so the model can keep responding instead of stalling.
 */
export function createSearchMemoryTool() {
  return tool({
    description:
      "Search long-term memory (Kioku) for facts about Goshujin-sama. Returns ranked atomic facts with their event date and source session. Call this whenever you'd benefit from past context — preferences, prior conversations, ongoing situations. The facts are short and atomic; you may need a couple of calls with different phrasings to triangulate.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Natural-language query — what you want to recall."),
      k: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many facts to return (1–20, default 8)."),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Inclusive lower bound on event date, YYYY-MM-DD."),
      until: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Inclusive upper bound on event date, YYYY-MM-DD."),
    }),
    execute: async ({ query, k, since, until }) => {
      try {
        logger.debug({ query, k, since, until }, "Tool: searchMemory");
        const facts = await recall(query, { k: k ?? 8, since, until });
        return { success: true, query, facts };
      } catch (err) {
        const reason =
          err instanceof KiokuClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : "memory search failed";
        logger.warn({ error: err, query }, "Tool: searchMemory failed");
        return { success: false, reason, facts: [], degraded: true };
      }
    },
  });
}

/**
 * Memory write tool. Appends a single atomic fact to the vault. Kioku
 * dedups by md5 + cosine, so calling this on a near-duplicate is
 * idempotent — the result surfaces `status: "duplicate"` with the
 * existing id rather than creating a new fact.
 */
export function createRememberFactTool() {
  return tool({
    description:
      'Save one atomic fact about Goshujin-sama to long-term memory (Kioku). Use this for durable observations he\'d want you to remember — preferences, milestones, ongoing situations. Keep facts short, single-claim, third-person ("User likes X" rather than "You like X"). Don\'t use this for transient context that the conversation will surface naturally; only for things worth remembering across sessions.',
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(800)
        .describe("The fact to remember. One claim, ideally <200 chars."),
      eventDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          "Date the fact is about (YYYY-MM-DD). Defaults to today. Use the actual event date when remembering something from the past.",
        ),
    }),
    execute: async ({ text, eventDate }) => {
      try {
        logger.debug({ text, eventDate }, "Tool: rememberFact");
        const result = await appendFactWithRetryQueue({
          text,
          event_date: eventDate,
          source_session: "rememberFact",
        });
        return { success: true, ...result };
      } catch (err) {
        const reason =
          err instanceof KiokuClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : "memory write failed";
        logger.error({ error: err, text }, "Tool: rememberFact failed");
        return { success: false, reason };
      }
    },
  });
}
