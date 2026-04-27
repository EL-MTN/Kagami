import { getDueSkills, claimPendingManualRun, resetStaleRunningSkillLogs } from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { executeSkill } from "../services/skill-executor";

const POLL_INTERVAL_MS = 60_000; // cron tick: 1 minute
const MANUAL_POLL_INTERVAL_MS = 3_000; // manual-run tick: 3 seconds

let interval: NodeJS.Timeout | null = null;
let manualInterval: NodeJS.Timeout | null = null;

async function runDueSkills(adapter: PlatformAdapter): Promise<void> {
  try {
    const skills = await getDueSkills();
    if (skills.length === 0) return;

    logger.info({ count: skills.length }, "Executing due skills");

    for (const skill of skills) {
      try {
        // Build default parameters from skill definition for cron triggers
        const defaults: Record<string, unknown> = {};
        for (const param of skill.parameters) {
          if (param.default !== undefined) {
            defaults[param.name] = param.default;
          }
        }

        await executeSkill(skill, adapter, {
          trigger: "cron",
          advanceSchedule: true,
          parameters: Object.keys(defaults).length > 0 ? defaults : undefined,
        });
      } catch (error) {
        logger.error({ error, skillId: skill._id, name: skill.name }, "Failed to execute skill");
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to poll due skills");
  }
}

async function runPendingManualRequest(adapter: PlatformAdapter): Promise<void> {
  try {
    const skill = await claimPendingManualRun();
    if (!skill) return;

    const params: Record<string, unknown> = {};
    for (const p of skill.parameters) {
      if (p.default !== undefined) params[p.name] = p.default;
    }

    logger.info({ skillId: skill._id, name: skill.name }, "Executing manual run request");
    await executeSkill(skill, adapter, {
      trigger: "manual",
      advanceSchedule: false,
      silent: true,
      parameters: Object.keys(params).length > 0 ? params : undefined,
    });
  } catch (error) {
    logger.error({ error }, "Failed to execute manual run request");
  }
}

async function startupRecovery(adapter: PlatformAdapter): Promise<void> {
  // Clean up stale "running" logs from crashed executions first
  try {
    const count = await resetStaleRunningSkillLogs();
    if (count > 0) {
      logger.info({ count }, "Reset stale running skill logs");
    }
  } catch (error) {
    logger.error({ error }, "Failed to reset stale skill logs");
  }

  // Then run any due skills
  await runDueSkills(adapter);
}

export function startSkillScheduler(adapter: PlatformAdapter): () => void {
  // Startup recovery: await stale reset before first poll
  void startupRecovery(adapter);

  interval = setInterval(() => void runDueSkills(adapter), POLL_INTERVAL_MS);
  interval.unref();

  manualInterval = setInterval(
    () => void runPendingManualRequest(adapter),
    MANUAL_POLL_INTERVAL_MS,
  );
  manualInterval.unref();

  logger.info("Skill scheduler started");

  return () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (manualInterval) {
      clearInterval(manualInterval);
      manualInterval = null;
    }
    logger.info("Skill scheduler stopped");
  };
}
