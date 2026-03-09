import { generateText } from "ai";
import { getModel } from "../ai/provider";
import { allTools, type ToolContext } from "../ai/tools/index";
import {
  TOOL_USAGE_INSTRUCTIONS,
  MAID_SERVICE_INSTRUCTIONS,
  BROWSER_INSTRUCTIONS,
  DATETIME_CONTEXT,
} from "../ai/prompts";
import { readVaultFile } from "@mashiro/memory";
import {
  isWorkflowRunning,
  createWorkflowLog,
  completeWorkflowLog,
  failWorkflowLog,
  advanceNextRunAt,
  type IWorkflow,
} from "@mashiro/db";
import { config, logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { extractResponseText, sendSegmented } from "../ai/response";
import { computeNextRunAt } from "./cron";

const LLM_TIMEOUT_MS = 180_000; // 3 minutes — workflows can be long
const NO_REPORT_SENTINEL = "[no report]";

async function assembleWorkflowSystemPrompt(workflow: IWorkflow): Promise<string> {
  const parts: string[] = [];

  // Personality card
  const personality = await readVaultFile("personality/card.md");
  if (personality) {
    parts.push(personality.content);
  } else {
    parts.push("You are Shiina Mashiro, a quiet and eccentric artist girlfriend.");
  }

  // Date/time context
  parts.push(DATETIME_CONTEXT(new Date()));

  // Tool instructions
  parts.push(TOOL_USAGE_INSTRUCTIONS);

  // Conditional service instructions
  if (config.GOOGLE_OAUTH_CLIENT_ID) {
    parts.push(MAID_SERVICE_INSTRUCTIONS);
  }
  if (config.BROWSER_ENABLED) {
    parts.push(BROWSER_INSTRUCTIONS);
  }

  // Workflow-specific instructions
  const reportInstruction =
    workflow.reportMode === "alert"
      ? `You are executing a scheduled workflow. Complete all the tasks described below using your tools. If everything is routine and nothing requires Goshujin-sama's attention, respond with exactly: ${NO_REPORT_SENTINEL}\nOnly write a real message if something is genuinely noteworthy, unusual, or failed.`
      : `You are executing a scheduled workflow. Complete all the tasks described below using your tools. When done, write a concise summary of what you found or accomplished to send to Goshujin-sama.`;

  parts.push(`## Workflow: ${workflow.name}\n${reportInstruction}`);

  return parts.join("\n\n---\n\n");
}

export interface ExecuteWorkflowOptions {
  /** Whether to advance the cron schedule after execution. Set false for manual triggers. */
  advanceSchedule?: boolean;
}

/**
 * Execute a single workflow. Used by both the scheduler and manual trigger.
 * Handles log creation, LLM execution, log finalization, and user notification.
 */
export async function executeWorkflow(
  workflow: IWorkflow,
  adapter: PlatformAdapter,
  options: ExecuteWorkflowOptions = {},
): Promise<void> {
  const { advanceSchedule = true } = options;
  const workflowId = workflow._id.toString();
  const chatId = workflow.chatId;

  // Guard: skip if already running
  if (await isWorkflowRunning(workflowId)) {
    logger.debug({ workflowId, name: workflow.name }, "Workflow already running, skipping");
    return;
  }

  const log = await createWorkflowLog(workflowId);
  const logId = log._id.toString();

  logger.info({ workflowId, name: workflow.name }, "Executing workflow");

  try {
    const systemPrompt = await assembleWorkflowSystemPrompt(workflow);

    const toolContext: ToolContext = {
      chatId,
      adapter,
      sessionId: `workflow-${workflowId}`,
    };

    const result = await generateText({
      model: getModel(),
      system: systemPrompt,
      messages: [{ role: "user", content: workflow.prompt }],
      tools: allTools(toolContext),
      maxSteps: 20,
      temperature: 0.4,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    const responseText = result.text || extractResponseText(result.steps) || "";

    // Log completion
    await completeWorkflowLog(logId, responseText);

    // Advance cron schedule from the previous slot to prevent drift
    if (advanceSchedule) {
      const nextRunAt = computeNextRunAt(workflow.cronSchedule, workflow.nextRunAt);
      await advanceNextRunAt(workflowId, nextRunAt);
      logger.info(
        { workflowId, name: workflow.name, nextRunAt, responseLength: responseText.length },
        "Workflow completed",
      );
    } else {
      logger.info(
        { workflowId, name: workflow.name, responseLength: responseText.length },
        "Workflow completed (manual trigger)",
      );
    }

    // Deliver report if there's meaningful content
    const isNoReport = responseText.trim().toLowerCase() === NO_REPORT_SENTINEL.toLowerCase();

    if (responseText && !isNoReport) {
      await sendSegmented(adapter, chatId, responseText);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Workflow execution failed";
    logger.error({ error, workflowId, name: workflow.name }, "Workflow execution failed");

    await failWorkflowLog(logId, reason).catch((e) => {
      logger.error({ error: e }, "Failed to update workflow log");
    });

    // Still advance the cron so we don't retry endlessly
    if (advanceSchedule) {
      try {
        const nextRunAt = computeNextRunAt(workflow.cronSchedule, workflow.nextRunAt);
        await advanceNextRunAt(workflowId, nextRunAt);
      } catch {
        // If cron computation fails, don't block error handling
      }
    }

    // Alert user about the failure
    await adapter.sendText(chatId, `Workflow "${workflow.name}" failed: ${reason}`).catch((e) => {
      logger.error({ error: e }, "Failed to send workflow error notification");
    });
  }
}
