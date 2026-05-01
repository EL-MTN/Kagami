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
import { createManageRoutinesTool } from "./manage-routines";
import { createSearchRoutinesTool } from "./search-routines";
import { createUseRoutineTool } from "./use-routine";
import { createSendVoiceTool } from "./send-voice";
import { createManageWatchersTool } from "./manage-watchers";
import { reportWatcherResult } from "./report-watcher-result";
import { createRequestConfirmationTool } from "./request-confirmation";
import { createCancelConfirmationTool } from "./cancel-confirmation";
import { MAX_ROUTINE_DEPTH } from "../../services/routine-executor";
import { config } from "@mashiro/shared";
import type { ToolSet } from "ai";
import type { PlatformAdapter } from "@mashiro/shared";

export interface ToolContext {
  chatId: string;
  adapter: PlatformAdapter;
  sessionId: string;
  /**
   * The user driving this turn. Set on conversational/proactive/
   * acknowledgment paths regardless of platform — for Telegram DMs it's
   * the numeric user id (which equals the chatId by convention); for
   * iMessage it's the participant handle (phone number or email).
   * Optional because cron-triggered routines have no active user. Used by
   * tools that may need to materialize a session (e.g. `cancelConfirmation`
   * → `appendConfirmationResolution`).
   */
  userId?: string;
  /** Current routine nesting depth. 0 = top-level conversation or manual routine trigger. */
  routineDepth?: number;
  /**
   * The execution context the tool set is being assembled for. "main" =
   * conversational chat or routine executor. "watcher" = inside a watcher tick
   * (read-only invariant). Used by `useRoutine` to gate by routine purity.
   * Defaults to "main" when omitted.
   */
  callingContext?: "main" | "watcher";
}

export function allTools(ctx: ToolContext) {
  const depth = ctx.routineDepth ?? 0;
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

  // Approval-gated wrappers. Registered when any gated underlying tool is
  // available — sendEmail/manageCalendar require Google OAuth, browseAgent
  // requires the browser. The wrapper's enum is the same in both cases; the
  // dispatcher fails at runtime if a tool is selected whose backing service
  // isn't configured. Behavioral guidance steers the LLM correctly.
  if (config.GOOGLE_OAUTH_CLIENT_ID || config.BROWSER_ENABLED) {
    tools.requestConfirmation = createRequestConfirmationTool(ctx.chatId, ctx.adapter);
    tools.cancelConfirmation = createCancelConfirmationTool(ctx.chatId, ctx.adapter, ctx.userId);
  }

  tools.manageRoutines = createManageRoutinesTool(ctx.chatId);
  tools.searchRoutines = createSearchRoutinesTool(ctx.chatId);
  tools.manageWatchers = createManageWatchersTool(ctx.chatId);

  // Only provide useRoutine when below max depth (prevents infinite recursion)
  if (depth < MAX_ROUTINE_DEPTH) {
    tools.useRoutine = createUseRoutineTool(ctx.chatId, ctx.adapter, depth, callingContext);
  }

  return tools;
}

/**
 * Shared read-only tool subset used by both the watcher executor and any
 * routine that runs under a watcher context. Excludes everything that mutates
 * external state: sends (email/photo/voice), memory writes (rememberFact /
 * noteToSelf / curateMemory), calendar/reminder writes, routine creation,
 * watcher creation, and the confirmation primitive (requestConfirmation /
 * cancelConfirmation — both write to the PendingConfirmation collection
 * and the underlying messaging surface). `useRoutine` IS included but
 * `callingContext: "watcher"` is hardcoded so any nested routine invocation
 * re-enters the gate.
 *
 * Does NOT include `reportWatcherResult` — that's the watcher executor's
 * terminator, irrelevant to routines running under watcher context.
 */
function readOnlyToolSubset(ctx: ToolContext): ToolSet {
  const depth = ctx.routineDepth ?? 0;

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

  if (depth < MAX_ROUTINE_DEPTH) {
    tools.useRoutine = createUseRoutineTool(ctx.chatId, ctx.adapter, depth, "watcher");
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
 * Tool set for a routine that's been invoked from a watcher. Same read-only
 * subset as `watcherTools` minus the watcher-specific terminator. Ensures
 * the watcher invariant is transitive: a read-purity routine called from a
 * watcher cannot itself send emails, write memory, or otherwise mutate
 * external state through its own tool palette.
 */
export function routineToolsUnderWatcher(ctx: ToolContext): ToolSet {
  return readOnlyToolSubset(ctx);
}
