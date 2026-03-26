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
import { createManageSkillsTool } from "./manage-skills";
import { createSearchSkillsTool } from "./search-skills";
import { createUseSkillTool } from "./use-skill";
import { createSendVoiceTool } from "./send-voice";
import { MAX_SKILL_DEPTH } from "../../services/skill-executor";
import { config } from "@mashiro/shared";
import type { ToolSet } from "ai";
import type { PlatformAdapter } from "@mashiro/shared";

export interface ToolContext {
  chatId: string;
  adapter: PlatformAdapter;
  sessionId: string;
  /** Current skill nesting depth. 0 = top-level conversation or manual skill trigger. */
  skillDepth?: number;
}

export function allTools(ctx: ToolContext) {
  const depth = ctx.skillDepth ?? 0;

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

  if (config.TTS_PROVIDER) {
    tools.sendVoice = createSendVoiceTool(ctx.chatId, ctx.adapter);
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

  tools.manageSkills = createManageSkillsTool(ctx.chatId);
  tools.searchSkills = createSearchSkillsTool(ctx.chatId);

  // Only provide useSkill when below max depth (prevents infinite recursion)
  if (depth < MAX_SKILL_DEPTH) {
    tools.useSkill = createUseSkillTool(ctx.chatId, ctx.adapter, depth);
  }

  return tools;
}
