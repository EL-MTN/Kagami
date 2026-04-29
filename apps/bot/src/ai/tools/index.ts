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
import { createBrowseTool, createReadOnlyBrowseTool } from "./browse";
import { createManageSkillsTool } from "./manage-skills";
import { createSearchSkillsTool } from "./search-skills";
import { createUseSkillTool } from "./use-skill";
import { createSendVoiceTool } from "./send-voice";
import { createManageWatchersTool } from "./manage-watchers";
import { reportWatcherResult } from "./report-watcher-result";
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
  /**
   * The execution context the tool set is being assembled for. "main" =
   * conversational chat or skill executor. "watcher" = inside a watcher tick
   * (read-only invariant). Used by `useSkill` to gate by skill purity.
   * Defaults to "main" when omitted.
   */
  callingContext?: "main" | "watcher";
}

export function allTools(ctx: ToolContext) {
  const depth = ctx.skillDepth ?? 0;
  const callingContext = ctx.callingContext ?? "main";

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
  tools.manageWatchers = createManageWatchersTool(ctx.chatId);

  // Only provide useSkill when below max depth (prevents infinite recursion)
  if (depth < MAX_SKILL_DEPTH) {
    tools.useSkill = createUseSkillTool(ctx.chatId, ctx.adapter, depth, callingContext);
  }

  return tools;
}

/**
 * Shared read-only tool subset used by both the watcher executor and any
 * skill that runs under a watcher context. Excludes everything that mutates
 * external state: sends (email/photo/voice), memory writes (rememberFact /
 * noteToSelf / curateMemory), calendar/reminder writes, skill creation,
 * watcher creation. `useSkill` IS included but `callingContext: "watcher"`
 * is hardcoded so any nested skill invocation re-enters the gate.
 *
 * Does NOT include `reportWatcherResult` — that's the watcher executor's
 * terminator, irrelevant to skills running under watcher context.
 */
function readOnlyToolSubset(ctx: ToolContext): ToolSet {
  const depth = ctx.skillDepth ?? 0;

  const tools: ToolSet = {
    readMemory,
    searchMemory,
    listMemories,
  };

  if (config.GOOGLE_OAUTH_CLIENT_ID) {
    tools.checkEmail = createCheckEmailTool();
    tools.listCalendarEvents = createManageCalendarTool({ mode: "readOnly" });
  }

  if (config.BROWSER_ENABLED) {
    tools.browse = createReadOnlyBrowseTool();
  }

  if (depth < MAX_SKILL_DEPTH) {
    tools.useSkill = createUseSkillTool(ctx.chatId, ctx.adapter, depth, "watcher");
  }

  return tools;
}

/**
 * Tool set for watcher executor ticks. Watchers observe; they never mutate
 * external state. Builds on the shared read-only subset and adds the
 * required `reportWatcherResult` terminator.
 */
export function watcherTools(ctx: ToolContext): ToolSet {
  return {
    ...readOnlyToolSubset(ctx),
    reportWatcherResult,
  };
}

/**
 * Tool set for a skill that's been invoked from a watcher. Same read-only
 * subset as `watcherTools` minus the watcher-specific terminator. Ensures
 * the watcher invariant is transitive: a read-purity skill called from a
 * watcher cannot itself send emails, write memory, or otherwise mutate
 * external state through its own tool palette.
 */
export function skillToolsUnderWatcher(ctx: ToolContext): ToolSet {
  return readOnlyToolSubset(ctx);
}
