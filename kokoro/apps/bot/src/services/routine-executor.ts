import { generateText, stepCountIs } from "ai";
import { getModel } from "../ai/provider";
import { allTools, routineToolsUnderWatcher, type ToolContext } from "../ai/tools/index";
import {
  isRoutineRunning,
  createRoutineLog,
  completeRoutineLog,
  failRoutineLog,
  advanceRoutineNextRunAt,
  NO_REPORT_SENTINEL,
  type IRoutine,
} from "@kokoro/db";
import { logger, computeNextRunAt } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { extractResponseText, sendSegmented } from "../ai/response";
import { trackUsage } from "../ai/token-tracker";
import { getModelName } from "../ai/provider";
import { DATETIME_CONTEXT } from "../ai/prompts";

export const MAX_ROUTINE_DEPTH = 3;
const LLM_TIMEOUT_MS = 180_000; // 3 minutes

const ROUTINE_EXECUTOR_IDENTITY = `You are a task executor. Complete the routine described below using your tools. Be concise and factual — return results, not commentary. Do not adopt a persona or use conversational tone.`;

function assembleRoutineSystemPrompt(
  routine: IRoutine,
  trigger: "cron" | "manual" | "routine",
  parameters?: Record<string, unknown>,
): string {
  const parts: string[] = [];

  // Lean identity — no personality card, no conversational instructions
  parts.push(ROUTINE_EXECUTOR_IDENTITY);

  // Datetime (always useful for time-aware tasks)
  parts.push(DATETIME_CONTEXT(new Date()));

  // Report mode instruction (only for cron triggers that report to user)
  if (trigger === "cron") {
    const reportInstruction =
      routine.reportMode === "alert"
        ? `After completing the task: if everything is routine, respond with exactly: ${NO_REPORT_SENTINEL}\nOnly write a report if something is noteworthy, unusual, or failed.`
        : `After completing the task, write a concise summary of what you found or accomplished.`;
    parts.push(reportInstruction);
  }

  // Routine section with parameters
  let routineSection = `## Routine: ${routine.name}`;

  if (parameters && Object.keys(parameters).length > 0) {
    const paramLines = Object.entries(parameters)
      .map(([key, value]) => `- **${key}**: ${String(value)}`)
      .join("\n");
    routineSection += `\n\n### Parameters\n${paramLines}`;
  }

  parts.push(routineSection);

  return parts.join("\n\n---\n\n");
}

interface ExecuteRoutineOptions {
  advanceSchedule?: boolean;
  trigger: "cron" | "manual" | "routine";
  parameters?: Record<string, unknown>;
  depth?: number;
  parentLogId?: string;
  /**
   * When true, suppresses Telegram delivery of the result and any failure
   * notification. The RoutineLog is still written, so callers (e.g. the
   * dashboard) can read the outcome.
   */
  silent?: boolean;
  /**
   * Propagates the watcher purity gate transitively. When a watcher invokes a
   * read-purity routine via useRoutine, that routine's executor must also assemble
   * its tool set with `callingContext: "watcher"` so any nested useRoutine call
   * is gated against action-purity routines. Defaults to "main".
   */
  callingContext?: "main" | "watcher";
}

/**
 * Execute a single routine. Used by the scheduler, manual trigger (manageRoutines), and composed calls (useRoutine).
 * Returns the response text for synchronous callers (useRoutine).
 */
export async function executeRoutine(
  routine: IRoutine,
  adapter: PlatformAdapter,
  options: ExecuteRoutineOptions,
): Promise<string> {
  const {
    advanceSchedule = false,
    trigger,
    parameters,
    depth = 0,
    parentLogId,
    silent = false,
    callingContext = "main",
  } = options;
  const routineId = routine._id.toString();
  const chatId = routine.chatId;

  // Guard: skip if already running (only for cron/manual, not composed calls)
  if (trigger !== "routine" && (await isRoutineRunning(routineId))) {
    logger.debug({ routineId, name: routine.name }, "Routine already running, skipping");
    return "";
  }

  const log = await createRoutineLog(routineId, trigger, { parentLogId, parameters });
  const logId = log._id.toString();

  logger.info({ routineId, name: routine.name, trigger, depth }, "Executing routine");

  try {
    const systemPrompt = assembleRoutineSystemPrompt(routine, trigger, parameters);

    const toolContext: ToolContext = {
      chatId,
      adapter,
      sessionId: `routine-${routineId}`,
      routineDepth: depth,
      callingContext,
      // `conversational` is left false: a routine run must never self-author
      // another routine. proposeRoutine is a user-initiated-turn affordance.
    };

    // Step limits by context
    let maxSteps: number;
    let temperature: number;
    if (trigger === "cron") {
      maxSteps = 20;
      temperature = 0.4;
    } else if (depth > 0) {
      maxSteps = 5;
      temperature = 0.4;
    } else {
      maxSteps = 10;
      temperature = 0.5;
    }

    // Under a watcher's calling context, the routine must run with the same
    // read-only tool palette as the watcher itself — otherwise a "purity:
    // read" routine could still mutate external state via rememberFact /
    // sendEmail / manageCalendar / etc., and the watcher invariant would
    // only hold for the watcher's direct tool surface.
    const tools =
      callingContext === "watcher" ? routineToolsUnderWatcher(toolContext) : allTools(toolContext);

    const result = await generateText({
      model: getModel(),
      system: systemPrompt,
      messages: [{ role: "user", content: routine.prompt }],
      tools,
      stopWhen: stepCountIs(maxSteps),
      temperature,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    const responseText = result.text || extractResponseText(result.steps) || "";

    // Track token usage
    trackUsage("routine", getModelName(), result.usage, {
      chatId,
      routineId,
      steps: result.steps.length,
    });

    // Log completion
    await completeRoutineLog(logId, responseText);

    // Advance cron schedule from the previous slot to prevent drift
    if (advanceSchedule && routine.cronSchedule && routine.nextRunAt) {
      const nextRunAt = computeNextRunAt(routine.cronSchedule, routine.nextRunAt);
      await advanceRoutineNextRunAt(routineId, nextRunAt);
      logger.info(
        { routineId, name: routine.name, nextRunAt, responseLength: responseText.length },
        "Routine completed (cron)",
      );
    } else {
      logger.info(
        { routineId, name: routine.name, trigger, responseLength: responseText.length },
        "Routine completed",
      );
    }

    // Deliver report to user if this is a cron or manual trigger (not composed,
    // not silent dashboard runs)
    if (trigger !== "routine" && !silent) {
      const isNoReport = responseText.trim().toLowerCase() === NO_REPORT_SENTINEL.toLowerCase();
      if (responseText && !isNoReport) {
        await sendSegmented(adapter, chatId, responseText);
      }
    }

    return responseText;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Routine execution failed";
    logger.error({ error: error, routineId, name: routine.name }, "Routine execution failed");

    await failRoutineLog(logId, reason).catch((e) => {
      logger.error({ error: e }, "Failed to update routine log");
    });

    // Still advance the cron so we don't retry endlessly
    if (advanceSchedule && routine.cronSchedule && routine.nextRunAt) {
      try {
        const nextRunAt = computeNextRunAt(routine.cronSchedule, routine.nextRunAt);
        await advanceRoutineNextRunAt(routineId, nextRunAt);
      } catch {
        // If cron computation fails, don't block error handling
      }
    }

    // Alert user about the failure (only for direct, non-silent triggers)
    if (trigger !== "routine" && !silent) {
      await adapter.sendText(chatId, `Routine "${routine.name}" failed: ${reason}`).catch((e) => {
        logger.error({ error: e }, "Failed to send routine error notification");
      });
    }

    return `Error: ${reason}`;
  }
}
