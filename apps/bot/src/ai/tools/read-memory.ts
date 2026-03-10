import { tool } from "ai";
import { z } from "zod";
import { readVaultFile } from "@mashiro/memory";
import { Memory } from "@mashiro/db";
import { logger } from "@mashiro/shared";

export const readMemory = tool({
  description:
    "Read from your memory. Use 'path' to read a vault file (e.g. personality card), or 'memoryId' to read a specific memory by its ID from the database.",
  inputSchema: z.object({
    path: z.string().optional().describe("Path relative to vault root, e.g. 'personality/card.md'"),
    memoryId: z.string().optional().describe("ID of a specific memory to read from the database"),
  }),
  execute: async ({ path, memoryId }) => {
    // Read a specific memory by ID
    if (memoryId) {
      logger.info({ memoryId }, "Tool: readMemory (by ID)");
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
    }

    // Read a vault file by path
    if (path) {
      logger.info({ path }, "Tool: readMemory (vault)");
      const file = await readVaultFile(path);
      if (!file) {
        logger.debug({ path }, "readMemory: file not found");
        return { found: false, error: `File not found: ${path}` };
      }
      logger.debug({ path, contentLength: file.content.length }, "readMemory: success");
      return { found: true, path: file.path, content: file.content };
    }

    return { found: false, error: "Provide either 'path' or 'memoryId'" };
  },
});
