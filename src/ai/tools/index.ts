import { readMemory } from "./read-memory.js";
import { writeMemory } from "./write-memory.js";
import { searchMemory } from "./search-memory.js";
import { listMemories } from "./list-memories.js";
import { createCurateMemoryTool } from "./curate-memory.js";
import { createSendPhotoTool } from "./send-photo.js";
import { createCheckEmailTool } from "./check-email.js";
import { createManageCalendarTool } from "./manage-calendar.js";
import { createManageRemindersTool } from "./manage-reminders.js";
import { config } from "../../config.js";
import type { CoreTool } from "ai";
import type { PlatformAdapter } from "../../platform/types.js";

export interface ToolContext {
  chatId: string;
  adapter: PlatformAdapter;
}

export function allTools(ctx: ToolContext) {
  const tools: Record<string, CoreTool> = {
    readMemory,
    writeMemory,
    searchMemory,
    listMemories,
    curateMemory: createCurateMemoryTool(ctx.chatId),
    sendPhoto: createSendPhotoTool(ctx.chatId, ctx.adapter),
  };

  if (config.GOOGLE_OAUTH_CLIENT_ID) {
    tools.checkEmail = createCheckEmailTool();
    tools.manageCalendar = createManageCalendarTool();
    tools.manageReminders = createManageRemindersTool(ctx.chatId);
  }

  return tools;
}
