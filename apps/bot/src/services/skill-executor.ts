import { generateText, stepCountIs } from "ai";
import { getModel } from "../ai/provider";
import { allTools, type ToolContext } from "../ai/tools/index";
import { assemblePromptShell } from "../ai/context-assembler";
import {
  isSkillRunning,
  createSkillLog,
  completeSkillLog,
  failSkillLog,
  advanceSkillNextRunAt,
  type ISkill,
} from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { extractResponseText, sendSegmented } from "../ai/response";
import { trackUsage } from "../ai/token-tracker";
import { getModelName } from "../ai/provider";
import { computeNextRunAt } from "./cron";

export const MAX_SKILL_DEPTH = 3;
const LLM_TIMEOUT_MS = 180_000; // 3 minutes
const NO_REPORT_SENTINEL = "[no report]";

async function assembleSkillSystemPrompt(
  skill: ISkill,
  parameters?: Record<string, unknown>,
): Promise<string> {
  const parts = await assemblePromptShell();

  // Report mode instruction (same as workflow pattern)
  const reportInstruction =
    skill.reportMode === "alert"
      ? `You are executing a skill. Complete all the tasks described below using your tools. If everything is routine and nothing requires Goshujin-sama's attention, respond with exactly: ${NO_REPORT_SENTINEL}\nOnly write a real message if something is genuinely noteworthy, unusual, or failed.`
      : `You are executing a skill. Complete all the tasks described below using your tools. When done, write a concise summary of what you found or accomplished.`;

  let skillSection = `## Skill: ${skill.name}\n${reportInstruction}`;

  // Inject parameters if present
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
  const { advanceSchedule = false, trigger, parameters, depth = 0, parentLogId } = options;
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
    const systemPrompt = await assembleSkillSystemPrompt(skill, parameters);

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

    // Deliver report to user if this is a cron or manual trigger (not composed)
    if (trigger !== "skill") {
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

    // Alert user about the failure (only for direct triggers)
    if (trigger !== "skill") {
      await adapter.sendText(chatId, `Skill "${skill.name}" failed: ${reason}`).catch((e) => {
        logger.error({ error: e }, "Failed to send skill error notification");
      });
    }

    return `Error: ${reason}`;
  }
}
