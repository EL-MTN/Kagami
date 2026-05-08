import { createSendPhotoTool, createSendVoiceTool } from "./media";
import { createCheckEmailTool, createSendEmailTool } from "./email";
import { createManageCalendarTool, createManageRemindersTool } from "./calendar";
import { createBrowseTool, createReadOnlyBrowseTool } from "./browse";
import { createWebSearchTool } from "./web-search";
import {
  createManageRoutinesTool,
  createSearchRoutinesTool,
  createUseRoutineTool,
} from "./routines";
import { createManageWatchersTool, reportWatcherResult } from "./watchers";
import { createRequestConfirmationTool, createCancelConfirmationTool } from "./confirmations";
import { createSearchMemoryTool, createRememberFactTool } from "./memory";
import { createCrmTools } from "./crm";
import { MAX_ROUTINE_DEPTH } from "../../services/routine-executor";
import { config } from "@kokoro/shared";
import type { ToolSet } from "ai";
import type { PlatformAdapter } from "@kokoro/shared";

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

  const tools: ToolSet = {};

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

  if (config.BRAVE_SEARCH_API_KEY) {
    tools.webSearch = createWebSearchTool();
  }

  if (config.BROWSER_ENABLED) {
    // When a standalone webSearch tool is registered, drop the in-browser
    // `search` action so the LLM has one obvious way to do lookups.
    tools.browse = createBrowseTool(ctx.chatId, ctx.adapter, {
      includeSearch: !config.BRAVE_SEARCH_API_KEY,
    });
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

  tools.searchMemory = createSearchMemoryTool();
  tools.rememberFact = createRememberFactTool();

  if (config.KIZUNA_ENABLED) {
    Object.assign(tools, createCrmTools());
  }

  // Only provide useRoutine when below max depth (prevents infinite recursion)
  if (depth < MAX_ROUTINE_DEPTH) {
    tools.useRoutine = createUseRoutineTool(ctx.chatId, ctx.adapter, depth, callingContext);
  }

  return tools;
}

/**
 * Shared read-only tool subset used by both the watcher executor and any
 * routine that runs under a watcher context. Excludes everything that mutates
 * external state: sends (email/photo/voice), calendar/reminder writes, routine
 * creation, watcher creation, and the confirmation primitive
 * (requestConfirmation / cancelConfirmation — both write to the
 * PendingConfirmation collection and the underlying messaging surface).
 * `useRoutine` IS included but `callingContext: "watcher"` is hardcoded so any
 * nested routine invocation re-enters the gate.
 *
 * Does NOT include `reportWatcherResult` — that's the watcher executor's
 * terminator, irrelevant to routines running under watcher context.
 */
function readOnlyToolSubset(ctx: ToolContext): ToolSet {
  const depth = ctx.routineDepth ?? 0;

  const tools: ToolSet = {};

  if (config.GOOGLE_OAUTH_CLIENT_ID) {
    tools.checkEmail = createCheckEmailTool();
    tools.listCalendarEvents = createManageCalendarTool({ mode: "readOnly" });
  }

  if (config.BRAVE_SEARCH_API_KEY) {
    tools.webSearch = createWebSearchTool();
  }

  if (config.BROWSER_ENABLED) {
    tools.browse = createReadOnlyBrowseTool({
      includeSearch: !config.BRAVE_SEARCH_API_KEY,
    });
  }

  if (depth < MAX_ROUTINE_DEPTH) {
    tools.useRoutine = createUseRoutineTool(ctx.chatId, ctx.adapter, depth, "watcher");
  }

  // Memory reads are pure — watchers observe what's already in the vault.
  // rememberFact is omitted because it mutates.
  tools.searchMemory = createSearchMemoryTool();

  if (config.KIZUNA_ENABLED) {
    Object.assign(tools, createCrmTools());
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
