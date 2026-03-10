import { readMemory } from "./read-memory";
import { rememberFact } from "./remember-fact";
import { createNoteToSelfTool } from "./note-to-self";
import { searchMemory } from "./search-memory";
import { listMemories } from "./list-memories";
import { createCurateMemoryTool } from "./curate-memory";
import { createSendPhotoTool } from "./send-photo";
import { createCheckEmailTool } from "./check-email";
import { createSendEmailTool } from "./send-email";
import { createManageCalendarTool } from "./manage-calendar";
import { createManageRemindersTool } from "./manage-reminders";
import { createBrowseTool } from "./browse";
import { createManageWorkflowsTool } from "./manage-workflows";
import { config } from "@mashiro/shared";
import type { ToolSet } from "ai";
import type { PlatformAdapter } from "@mashiro/shared";

export interface ToolContext {
  chatId: string;
  adapter: PlatformAdapter;
  sessionId: string;
}

export function allTools(ctx: ToolContext) {
  const tools: ToolSet = {
    readMemory,
    rememberFact,
    noteToSelf: createNoteToSelfTool(ctx.sessionId),
    searchMemory,
    listMemories,
    curateMemory: createCurateMemoryTool(ctx.chatId),
  };

  if (config.IMAGE_GENERATION_MODEL) {
    tools.sendPhoto = createSendPhotoTool(ctx.chatId, ctx.adapter);
  }

  if (config.GOOGLE_OAUTH_CLIENT_ID) {
    tools.checkEmail = createCheckEmailTool();
    tools.sendEmail = createSendEmailTool();
    tools.manageCalendar = createManageCalendarTool();
    tools.manageReminders = createManageRemindersTool(ctx.chatId);
  }

  if (config.BROWSER_ENABLED) {
    tools.browse = createBrowseTool(ctx.chatId, ctx.adapter);
  }

  tools.manageWorkflows = createManageWorkflowsTool(ctx.chatId, ctx.adapter);

  return tools;
}
