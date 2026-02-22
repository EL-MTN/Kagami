import { tool } from "ai";
import { z } from "zod";
import { readVaultFile } from "../../memory/vault.js";
import { logger } from "../../utils/logger.js";

export const readMemory = tool({
  description:
    "Read a specific file from the memory vault. Use to recall stored information like facts about him, milestones, or past conversation summaries.",
  parameters: z.object({
    path: z
      .string()
      .describe(
        "Path relative to vault root, e.g. 'memories/about-you.md' or 'memories/conversations/2026-02-20.md'",
      ),
  }),
  execute: async ({ path }) => {
    logger.info({ path }, "Tool: readMemory");
    const file = await readVaultFile(path);
    if (!file) {
      logger.debug({ path }, "readMemory: file not found");
      return { found: false, error: `File not found: ${path}` };
    }
    logger.debug({ path, contentLength: file.content.length }, "readMemory: success");
    return { found: true, path: file.path, content: file.content };
  },
});
