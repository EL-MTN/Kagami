import { readMemory } from "./read-memory.js";
import { writeMemory } from "./write-memory.js";
import { searchMemory } from "./search-memory.js";
import { curateMemory } from "./curate-memory.js";
import { createSendPhotoTool } from "./send-photo.js";
import { checkCalendar } from "./check-calendar.js";
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
    curateMemory,
    sendPhoto: createSendPhotoTool(ctx.chatId, ctx.adapter),
    checkCalendar,
  };
}
