import { generateText, stepCountIs } from "ai";
import { getModel } from "../ai/provider";
import { allTools, type ToolContext } from "../ai/tools/index";
import {
  isSkillRunning,
  createSkillLog,
  completeSkillLog,
  failSkillLog,
  advanceSkillNextRunAt,
  type ISkill,
} from "@mashiro/db";
import { logger, computeNextRunAt } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { extractResponseText, sendSegmented } from "../ai/response";
import { trackUsage } from "../ai/token-tracker";
import { getModelName } from "../ai/provider";
import { DATETIME_CONTEXT } from "../ai/prompts";

export const MAX_SKILL_DEPTH = 3;
const LLM_TIMEOUT_MS = 180_000; // 3 minutes
const NO_REPORT_SENTINEL = "[no report]";

const SKILL_EXECUTOR_IDENTITY = `You are a task executor. Complete the skill described below using your tools. Be concise and factual — return results, not commentary. Do not adopt a persona or use conversational tone.`;

function assembleSkillSystemPrompt(
  skill: ISkill,
  trigger: "cron" | "manual" | "skill",
  parameters?: Record<string, unknown>,
): string {
  const parts: string[] = [];

  // Lean identity — no personality card, no conversational instructions
  parts.push(SKILL_EXECUTOR_IDENTITY);

  // Datetime (always useful for time-aware tasks)
  parts.push(DATETIME_CONTEXT(new Date()));

  // Report mode instruction (only for cron triggers that report to user)
  if (trigger === "cron") {
    const reportInstruction =
      skill.reportMode === "alert"
        ? `After completing the task: if everything is routine, respond with exactly: ${NO_REPORT_SENTINEL}\nOnly write a report if something is noteworthy, unusual, or failed.`
        : `After completing the task, write a concise summary of what you found or accomplished.`;
    parts.push(reportInstruction);
  }

  // Skill section with parameters
  let skillSection = `## Skill: ${skill.name}`;

  if (parameters && Object.keys(parameters).length > 0) {
    const paramLines = Object.entries(parameters)
      .map(([key, value]) => `- **${key}**: ${String(value)}`)
      .join("\n");
    skillSection += `\n\n### Parameters\n${paramLines}`;
  }

  parts.push(skillSection);

  return parts.join("\n\n---\n\n");
}

export interface ExecuteSkillOptions {
  advanceSchedule?: boolean;
  trigger: "cron" | "manual" | "skill";
  parameters?: Record<string, unknown>;
  depth?: number;
  parentLogId?: string;
  /**
   * When true, suppresses Telegram delivery of the result and any failure
   * notification. The SkillLog is still written, so callers (e.g. the
   * dashboard) can read the outcome.
   */
  silent?: boolean;
}

/**
 * Execute a single skill. Used by the scheduler, manual trigger (manageSkills), and composed calls (useSkill).
 * Returns the response text for synchronous callers (useSkill).
 */
export async function executeSkill(
  skill: ISkill,
  adapter: PlatformAdapter,
  options: ExecuteSkillOptions,
): Promise<string> {
  const {
    advanceSchedule = false,
    trigger,
    parameters,
    depth = 0,
    parentLogId,
    silent = false,
  } = options;
  const skillId = skill._id.toString();
  const chatId = skill.chatId;

  // Guard: skip if already running (only for cron/manual, not composed calls)
  if (trigger !== "skill" && (await isSkillRunning(skillId))) {
    logger.debug({ skillId, name: skill.name }, "Skill already running, skipping");
    return "";
  }

  const log = await createSkillLog(skillId, trigger, { parentLogId, parameters });
  const logId = log._id.toString();

  logger.info({ skillId, name: skill.name, trigger, depth }, "Executing skill");

  try {
    const systemPrompt = assembleSkillSystemPrompt(skill, trigger, parameters);

    const toolContext: ToolContext = {
      chatId,
      adapter,
      sessionId: `skill-${skillId}`,
      skillDepth: depth,
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

    const result = await generateText({
      model: getModel(),
      system: systemPrompt,
      messages: [{ role: "user", content: skill.prompt }],
      tools: allTools(toolContext),
      stopWhen: stepCountIs(maxSteps),
      temperature,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    const responseText = result.text || extractResponseText(result.steps) || "";

    // Track token usage
    trackUsage("skill", getModelName(), result.usage, {
      chatId,
      skillId,
      steps: result.steps.length,
    });

    // Log completion
    await completeSkillLog(logId, responseText);

    // Advance cron schedule from the previous slot to prevent drift
    if (advanceSchedule && skill.cronSchedule && skill.nextRunAt) {
      const nextRunAt = computeNextRunAt(skill.cronSchedule, skill.nextRunAt);
      await advanceSkillNextRunAt(skillId, nextRunAt);
      logger.info(
        { skillId, name: skill.name, nextRunAt, responseLength: responseText.length },
        "Skill completed (cron)",
      );
    } else {
      logger.info(
        { skillId, name: skill.name, trigger, responseLength: responseText.length },
        "Skill completed",
      );
    }

    // Deliver report to user if this is a cron or manual trigger (not composed,
    // not silent dashboard runs)
    if (trigger !== "skill" && !silent) {
      const isNoReport = responseText.trim().toLowerCase() === NO_REPORT_SENTINEL.toLowerCase();
      if (responseText && !isNoReport) {
        await sendSegmented(adapter, chatId, responseText);
      }
    }

    return responseText;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Skill execution failed";
    logger.error({ error, skillId, name: skill.name }, "Skill execution failed");

    await failSkillLog(logId, reason).catch((e) => {
      logger.error({ error: e }, "Failed to update skill log");
    });

    // Still advance the cron so we don't retry endlessly
    if (advanceSchedule && skill.cronSchedule && skill.nextRunAt) {
      try {
        const nextRunAt = computeNextRunAt(skill.cronSchedule, skill.nextRunAt);
        await advanceSkillNextRunAt(skillId, nextRunAt);
      } catch {
        // If cron computation fails, don't block error handling
      }
    }

    // Alert user about the failure (only for direct, non-silent triggers)
    if (trigger !== "skill" && !silent) {
      await adapter.sendText(chatId, `Skill "${skill.name}" failed: ${reason}`).catch((e) => {
        logger.error({ error: e }, "Failed to send skill error notification");
      });
    }

    return `Error: ${reason}`;
  }
}
