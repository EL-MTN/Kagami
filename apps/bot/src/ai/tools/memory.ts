import { tool } from "ai";
import { z } from "zod";
import { format } from "date-fns";
import { Memory } from "@mashiro/db";
import * as engine from "@mashiro/memory";
import { logger } from "@mashiro/shared";
import { curateIfNeeded } from "../../memory/curator";

export const readMemory = tool({
  description: "Read a specific memory by its ID from the database.",
  inputSchema: z.object({
    memoryId: z.string().describe("ID of the memory to read"),
  }),
  execute: async ({ memoryId }) => {
    logger.info({ memoryId }, "Tool: readMemory");
    const memory = await Memory.findById(memoryId);
    if (!memory) {
      return { found: false, error: `Memory not found: ${memoryId}` };
    }
    return {
      found: true,
      id: memory._id.toString(),
      type: memory.type,
      content: memory.content,
      createdAt: memory.metadata.createdAt,
      importance: memory.metadata.importance,
    };
  },
});

export const searchMemory = tool({
  description:
    "Search across all memories using semantic understanding. Finds relevant information even when exact words don't match. Use when you need to find information but aren't sure where it is.",
  inputSchema: z.object({
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

export const listMemories = tool({
  description:
    "List available memories by type. Use to discover past conversation summaries, stored facts, or milestones. Helpful when you want to see what you remember.",
  inputSchema: z.object({
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

export function createNoteToSelfTool(sessionId: string) {
  return tool({
    description:
      "Make a temporary note to yourself for this session. Use for things you want to track short-term: what he's cooking, a topic to circle back to, something to ask about later. These notes auto-expire after 24 hours.",
    inputSchema: z.object({
      note: z.string().describe("The note to save for this session"),
    }),
    execute: async ({ note }) => {
      logger.info({ sessionId, notePreview: note.slice(0, 80) }, "Tool: noteToSelf");

      const memory = await engine.setWorkingMemory(note, sessionId);

      return {
        success: true,
        memoryId: memory._id.toString(),
        note,
        expiresIn: "24 hours",
      };
    },
  });
}

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
