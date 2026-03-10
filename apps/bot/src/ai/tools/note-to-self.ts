import { tool } from "ai";
import { z } from "zod";
import * as engine from "@mashiro/memory";
import { logger } from "@mashiro/shared";

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
