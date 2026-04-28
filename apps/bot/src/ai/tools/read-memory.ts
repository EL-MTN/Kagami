import { tool } from "ai";
import { z } from "zod";
import { Memory } from "@mashiro/db";
import { logger } from "@mashiro/shared";

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
