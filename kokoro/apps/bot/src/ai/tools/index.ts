import { createSendPhotoTool, createSendVoiceTool } from "./media";
import { createCheckEmailTool, createSendEmailTool } from "./email";
import { createManageCalendarTool, createManageRemindersTool } from "./calendar";
import { createBrowseTool, createReadOnlyBrowseTool } from "./browse";
import { createWebSearchTool } from "./web-search";
import { createGetCurrentTimeTool } from "./time";
import {
  createManageRoutinesTool,
  createSearchRoutinesTool,
  createUseRoutineTool,
} from "./routines";
import { createProposeSkillTool, createReadSkillTool, createSearchSkillsTool } from "./skills";
import { createManageWatchersTool, reportWatcherResult } from "./watchers";
import { createRequestConfirmationTool, createCancelConfirmationTool } from "./confirmations";
import { createProposeRoutineTool } from "./routine-proposals";
import { createProposeRoutineRefinementTool } from "./routine-refinements";
import { createDelegateTool } from "./delegate";
import { createSearchMemoryTool, createRememberFactTool } from "./memory";
import { createCrmTools, createCrmWriteTools } from "./crm";
import { getMcpTools } from "../../services/mcp";
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
   * The RoutineLog id of the currently-executing routine run, set by
   * `executeRoutine` on the tool context it assembles. Composition tools
   * (`useRoutine`, `delegate`) forward it as the `parentLogId` of any routine
   * they spawn, so the dashboard can render a parent→children run tree.
   * Absent on conversational/proactive turns — those aren't a RoutineLog, so a
   * spawned routine run is a standalone root.
   */
  routineLogId?: string;
  /**
   * True only for a live, user-initiated conversational turn (`generate.ts`).
   * Proactive outreach, routine executions, watcher ticks, and the
   * acknowledgment turn all leave it false — they share `callingContext: "main"`
   * with conversation but are NOT moments where the user just asked for a
   * multi-step task. Gates `proposeRoutine` (a conversational, user-present
   * affordance): offering to save a routine only makes sense right after the
   * user drove a task to completion. Positive opt-in so any new non-
   * conversational `allTools` caller is excluded by default.
   */
  conversational?: boolean;
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

  if (config.KAO_URL) {
    tools.checkEmail = createCheckEmailTool();
    tools.sendEmail = createSendEmailTool();
    tools.manageCalendar = createManageCalendarTool();
    tools.manageReminders = createManageRemindersTool(ctx.chatId);
  }

  if (config.BRAVE_SEARCH_API_KEY) {
    tools.webSearch = createWebSearchTool();
  }

  // When a standalone webSearch tool is registered, drop the in-browser
  // `search` action so the LLM has one obvious way to do lookups.
  tools.browse = createBrowseTool(ctx.chatId, ctx.adapter, {
    includeSearch: !config.BRAVE_SEARCH_API_KEY,
  });

  // Read-only, local: a fresh precise-time read (the user's local time is
  // ambient every turn; this covers long-task drift and other timezones).
  tools.getCurrentTime = createGetCurrentTimeTool();

  // Approval-gated wrappers. Always registered now that browser automation and
  // CRM writes are unconditional (sendEmail/manageCalendar still require Kao for
  // Google access). The wrapper's enum is the same in all cases; the dispatcher
  // fails at runtime if a tool is selected whose backing service isn't
  // configured. Behavioral guidance steers the LLM correctly.
  tools.requestConfirmation = createRequestConfirmationTool(ctx.chatId, ctx.adapter);
  tools.cancelConfirmation = createCancelConfirmationTool(ctx.chatId, ctx.adapter, ctx.userId);

  tools.manageRoutines = createManageRoutinesTool(ctx.chatId);
  tools.searchRoutines = createSearchRoutinesTool(ctx.chatId);
  tools.searchSkills = createSearchSkillsTool(ctx.chatId);
  tools.readSkill = createReadSkillTool(ctx.chatId);
  tools.manageWatchers = createManageWatchersTool(ctx.chatId);

  // Self-authored artifacts: let the model offer to save a just-completed task
  // (`proposeRoutine`), save durable procedural guidance (`proposeSkill`), or
  // fix an underperforming routine's prompt (`proposeRoutineRefinement`). Live
  // conversational turns ONLY
  // (`ctx.conversational`) — structurally absent from watcherTools /
  // routineToolsUnderWatcher, and withheld from every other allTools caller that
  // runs under callingContext: "main" but isn't a user-initiated turn (proactive
  // outreach, routine executions). A scheduled/manual/composed routine — or an
  // unprompted proactive message — must never self-author or self-edit a
  // routine or skill. Approved actions are dispatch-only (`createRoutine` /
  // `createSkill` / `updateRoutinePrompt`), gated behind the approval rail.
  if (ctx.conversational) {
    tools.proposeRoutine = createProposeRoutineTool(ctx.chatId, ctx.adapter);
    tools.proposeRoutineRefinement = createProposeRoutineRefinementTool(ctx.chatId, ctx.adapter);
    tools.proposeSkill = createProposeSkillTool(ctx.chatId, ctx.adapter);
  }

  tools.searchMemory = createSearchMemoryTool();
  tools.rememberFact = createRememberFactTool();

  Object.assign(tools, createCrmTools());
  Object.assign(tools, createCrmWriteTools());

  // Only provide useRoutine when below max depth (prevents infinite recursion)
  if (depth < MAX_ROUTINE_DEPTH) {
    tools.useRoutine = createUseRoutineTool(
      ctx.chatId,
      ctx.adapter,
      depth,
      callingContext,
      ctx.routineLogId,
    );
    // `delegate` fans out independent read-only sub-tasks in parallel. Each
    // sub-task runs on `readOnlyToolSubset` — the same read-only palette the
    // watcher invariant uses — so a fan-out can only gather/analyse, never
    // mutate, and (lacking `delegate` itself) can't deepen the tree further.
    // Gated by the same depth bound as useRoutine, AND restricted to "main"
    // context: an observation (watcher) run must never fan out fresh LLM calls.
    // allTools is only ever called for main today, so this is defense-in-depth —
    // a future allTools(ctx, "watcher") caller can't inherit delegate.
    if (callingContext === "main") {
      tools.delegate = createDelegateTool(ctx, readOnlyToolSubset);
    }
  }

  // External MCP tools mounted at startup (initMcp). Namespaced `mcp_*` so they
  // never shadow a built-in; merged only here (the "main" palette), never into
  // the watcher read-only subset whose tools' read/write purity is known. The
  // `in` guard keeps a built-in winning on any (prefix-impossible) collision.
  for (const [key, tool] of Object.entries(getMcpTools())) {
    if (!(key in tools)) tools[key] = tool;
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

  if (config.KAO_URL) {
    tools.checkEmail = createCheckEmailTool();
    tools.listCalendarEvents = createManageCalendarTool({ mode: "readOnly" });
  }

  if (config.BRAVE_SEARCH_API_KEY) {
    tools.webSearch = createWebSearchTool();
  }

  tools.browse = createReadOnlyBrowseTool({
    includeSearch: !config.BRAVE_SEARCH_API_KEY,
  });

  // Pure read — safe for watcher/observation runs.
  tools.getCurrentTime = createGetCurrentTimeTool();

  if (depth < MAX_ROUTINE_DEPTH) {
    tools.useRoutine = createUseRoutineTool(
      ctx.chatId,
      ctx.adapter,
      depth,
      "watcher",
      ctx.routineLogId,
    );
  }

  // Memory reads are pure — watchers observe what's already in the vault.
  // rememberFact is omitted because it mutates.
  tools.searchMemory = createSearchMemoryTool();

  // Skills are procedural context reads. They do not execute or mutate state,
  // so they are safe for watcher/under-watcher observation runs.
  tools.searchSkills = createSearchSkillsTool(ctx.chatId);
  tools.readSkill = createReadSkillTool(ctx.chatId);

  Object.assign(tools, createCrmTools());

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
