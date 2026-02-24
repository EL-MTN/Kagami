import { readMemory } from "./read-memory.js";
import { writeMemory } from "./write-memory.js";
import { searchMemory } from "./search-memory.js";
import { listMemories } from "./list-memories.js";
import { createCurateMemoryTool } from "./curate-memory.js";
import { createSendPhotoTool } from "./send-photo.js";
import type { PlatformAdapter } from "../../platform/types.js";

export interface ToolContext {
  chatId: string;
  adapter: PlatformAdapter;
}

export function allTools(ctx: ToolContext) {
  return {
    readMemory,
    writeMemory,
    searchMemory,
    listMemories,
    curateMemory: createCurateMemoryTool(ctx.chatId),
    sendPhoto: createSendPhotoTool(ctx.chatId, ctx.adapter),
  };
}
