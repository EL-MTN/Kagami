import { readMemory } from "./read-memory.js";
import { rememberFact } from "./remember-fact.js";
import { createNoteToSelfTool } from "./note-to-self.js";
import { searchMemory } from "./search-memory.js";
import { listMemories } from "./list-memories.js";
import { createCurateMemoryTool } from "./curate-memory.js";
import { createSendPhotoTool } from "./send-photo.js";
import { createCheckEmailTool } from "./check-email.js";
import { createSendEmailTool } from "./send-email.js";
import { createManageCalendarTool } from "./manage-calendar.js";
import { createManageRemindersTool } from "./manage-reminders.js";
import { createBrowseTool } from "./browse.js";
import { config } from "@mashiro/shared";
import type { CoreTool } from "ai";
import type { PlatformAdapter } from "@mashiro/shared";

export interface ToolContext {
  chatId: string;
  adapter: PlatformAdapter;
  sessionId: string;
}

export function allTools(ctx: ToolContext) {
  const tools: Record<string, CoreTool> = {
    readMemory,
    rememberFact,
    noteToSelf: createNoteToSelfTool(ctx.sessionId),
    searchMemory,
    listMemories,
    curateMemory: createCurateMemoryTool(ctx.chatId),
    sendPhoto: createSendPhotoTool(ctx.chatId, ctx.adapter),
  };

  if (config.GOOGLE_OAUTH_CLIENT_ID) {
    tools.checkEmail = createCheckEmailTool();
    tools.sendEmail = createSendEmailTool();
    tools.manageCalendar = createManageCalendarTool();
    tools.manageReminders = createManageRemindersTool(ctx.chatId);
  }

  if (config.BROWSER_ENABLED) {
    tools.browse = createBrowseTool(ctx.chatId, ctx.adapter);
  }

  return tools;
}
