import { generateText, hasToolCall, stepCountIs, type StepResult } from "ai";
import { getModel, getModelName } from "../ai/provider";
import { watcherTools, type ToolContext } from "../ai/tools/index";
import {
  isWatcherRunning,
  createWatcherLog,
  completeWatcherLog,
  failWatcherLog,
  advanceWatcherNextRunAt,
  recordWatcherObservation,
  type IWatcher,
} from "@mashiro/db";
import { logger, computeNextRunAt } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { sendSegmented } from "../ai/response";
import { trackUsage } from "../ai/token-tracker";
import { DATETIME_CONTEXT } from "../ai/prompts";
import {
  REPORT_WATCHER_RESULT_TOOL_NAME,
  reportWatcherResultInputSchema,
  type WatcherResult,
} from "../ai/tools/report-watcher-result";

const LLM_TIMEOUT_MS = 180_000; // 3 minutes
const MAX_STEPS = 10;
const TEMPERATURE = 0.3;

const WATCHER_EXECUTOR_IDENTITY = `You are a detection agent. Your job is to check whether a specific condition has occurred since the last observation, and report back in a structured form. Be precise and factual — no commentary, no persona, no conversational tone.`;

function assembleWatcherSystemPrompt(watcher: IWatcher): string {
  const parts: string[] = [];

  parts.push(WATCHER_EXECUTOR_IDENTITY);
  parts.push(DATETIME_CONTEXT(new Date()));

  const lastState = watcher.lastState ?? "(none — this is the first check)";
  parts.push(`## Last state\n${lastState}`);

  parts.push(`## Watcher: ${watcher.name}\n${watcher.prompt}`);

  parts.push(
    [
      "## Instructions",
      "- Use available tools to gather what you need.",
      `- When you've gathered enough information, call \`${REPORT_WATCHER_RESULT_TOOL_NAME}\` exactly once to terminate. Do not output free-form text after that.`,
      "- triggered: true ONLY if the watch condition is met (or has changed since last state in a way the user cares about). Otherwise false.",
      "- summary: one short paragraph. Sent to the user when triggered=true.",
      "- newState: a concise snapshot of the current observation. Captures the reference data for the next check.",
    ].join("\n"),
  );

  return parts.join("\n\n---\n\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Step = StepResult<any>;

function extractWatcherResult(steps: Step[]): WatcherResult | null {
  // Walk in reverse — use the latest reportWatcherResult call if multiple exist.
  for (let i = steps.length - 1; i >= 0; i--) {
    const calls = steps[i].toolCalls ?? [];
    for (let j = calls.length - 1; j >= 0; j--) {
      const tc = calls[j];
      if (tc.toolName !== REPORT_WATCHER_RESULT_TOOL_NAME) continue;
      const parsed = reportWatcherResultInputSchema.safeParse(tc.input);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

function formatTriggerMessage(watcher: IWatcher, summary: string): string {
  return `👀 ${watcher.name}\n\n${summary}`;
}

export interface ExecuteWatcherOptions {
  trigger: "cron" | "manual";
  advanceSchedule?: boolean;
  /** When true, suppresses notification delivery even on triggered=true. */
  silent?: boolean;
}

/**
 * Execute a single watcher tick. Writes a WatcherLog, updates lastState,
 * advances the cron, and sends a notification only when triggered=true.
 */
export async function executeWatcher(
  watcher: IWatcher,
  adapter: PlatformAdapter,
  options: ExecuteWatcherOptions,
): Promise<void> {
  const { trigger, advanceSchedule = false, silent = false } = options;
  const watcherId = watcher._id.toString();
  const chatId = watcher.chatId;

  if (await isWatcherRunning(watcherId)) {
    logger.debug({ watcherId, name: watcher.name }, "Watcher already running, skipping");
    return;
  }

  const log = await createWatcherLog(watcherId, trigger);
  const logId = log._id.toString();

  logger.info({ watcherId, name: watcher.name, trigger }, "Executing watcher");

  try {
    const systemPrompt = assembleWatcherSystemPrompt(watcher);

    const toolContext: ToolContext = {
      chatId,
      adapter,
      sessionId: `watcher-${watcherId}`,
    };

    const result = await generateText({
      model: getModel(),
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: "Run this check now and report the result.",
        },
      ],
      tools: watcherTools(toolContext),
      // Stop as soon as the watcher reports — saves wasted steps after termination.
      stopWhen: [stepCountIs(MAX_STEPS), hasToolCall(REPORT_WATCHER_RESULT_TOOL_NAME)],
      temperature: TEMPERATURE,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    trackUsage("watcher", getModelName(), result.usage, {
      chatId,
      watcherId,
      steps: result.steps.length,
    });

    const reported = extractWatcherResult(result.steps);

    if (!reported) {
      const reason = "Watcher did not call reportWatcherResult";
      logger.warn({ watcherId, name: watcher.name, steps: result.steps.length }, reason);
      await failWatcherLog(logId, reason);
      await advanceCron(watcher, advanceSchedule);
      return;
    }

    await completeWatcherLog(logId, reported);
    await recordWatcherObservation(watcherId, {
      newState: reported.newState,
      triggered: reported.triggered,
    });

    await advanceCron(watcher, advanceSchedule);

    logger.info(
      {
        watcherId,
        name: watcher.name,
        triggered: reported.triggered,
        summaryLength: reported.summary.length,
      },
      "Watcher completed",
    );

    if (reported.triggered && !silent) {
      await sendSegmented(adapter, chatId, formatTriggerMessage(watcher, reported.summary));
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Watcher execution failed";
    logger.error({ error, watcherId, name: watcher.name }, "Watcher execution failed");

    await failWatcherLog(logId, reason).catch((e) => {
      logger.error({ error: e }, "Failed to update watcher log");
    });

    await advanceCron(watcher, advanceSchedule);

    if (!silent) {
      await adapter
        .sendText(chatId, `Watcher "${watcher.name}" failed: ${reason}`)
        .catch((e) => logger.error({ error: e }, "Failed to send watcher error notification"));
    }
  }
}

/**
 * Advance the watcher's cron schedule. Anchors from max(nextRunAt, now) so
 * a long-stale slot (e.g. after a failure burst or downtime) doesn't replay
 * the past — the next run is always strictly in the future.
 */
async function advanceCron(watcher: IWatcher, advanceSchedule: boolean): Promise<void> {
  if (!advanceSchedule || !watcher.nextRunAt) return;
  try {
    const anchor = new Date(Math.max(watcher.nextRunAt.getTime(), Date.now()));
    const nextRunAt = computeNextRunAt(watcher.cronSchedule, anchor);
    await advanceWatcherNextRunAt(watcher._id.toString(), nextRunAt);
  } catch (error) {
    logger.error(
      { error, watcherId: watcher._id, name: watcher.name },
      "Failed to advance watcher cron",
    );
  }
}
