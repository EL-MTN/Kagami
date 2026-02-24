import { tool } from "ai";
import { z } from "zod";
import { readVaultFile, writeVaultFile, appendToVaultFile } from "../../memory/vault.js";
import * as engine from "../../memory/engine.js";
import { logger } from "../../utils/logger.js";

export const writeMemory = tool({
  description:
    "Save important information to the memory vault. The tool returns the current file contents after writing so you can see what's stored. Do NOT re-write information that's already there.",
  parameters: z.object({
    path: z.string().describe("Path relative to vault root, e.g. 'memories/about-you.md'"),
    content: z
      .string()
      .describe("Only NEW bullet points or lines to add. Do not repeat existing content."),
    mode: z
      .enum(["append", "overwrite"])
      .default("append")
      .describe(
        "'append' adds new lines (deduped). 'overwrite' replaces the whole file — use only for reorganizing.",
      ),
  }),
  execute: async ({ path, content, mode }) => {
    logger.info({ path, mode, contentPreview: content.slice(0, 80) }, "Tool: writeMemory");

    if (mode === "overwrite") {
      await writeVaultFile(path, content);
    } else {
      await appendToVaultFile(path, content);
    }

    // Dual-write: also store facts in Memory collection for semantic search
    if (path.includes("about-you") || path.includes("milestones")) {
      const type = path.includes("milestones") ? ("milestone" as const) : ("fact" as const);
      await engine.remember(content, type, "tool", { vaultPath: path }).catch((error) => {
        logger.warn({ error, path }, "Failed to dual-write to Memory collection");
      });
    }

    // Return current state so the LLM sees what's stored
    const current = await readVaultFile(path);
    return {
      success: true,
      path,
      mode,
      currentContent: current?.content ?? content,
    };
  },
});
