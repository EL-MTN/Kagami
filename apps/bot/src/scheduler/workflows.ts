import { getDueWorkflows, resetStaleRunningLogs } from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { executeWorkflow } from "../services/workflow-executor.js";

const POLL_INTERVAL_MS = 60_000; // 1 minute

let interval: NodeJS.Timeout | null = null;

async function runDueWorkflows(adapter: PlatformAdapter): Promise<void> {
  try {
    const workflows = await getDueWorkflows();
    if (workflows.length === 0) return;

    logger.info({ count: workflows.length }, "Executing due workflows");

    for (const workflow of workflows) {
      try {
        await executeWorkflow(workflow, adapter);
      } catch (error) {
        logger.error(
          { error, workflowId: workflow._id, name: workflow.name },
          "Failed to execute workflow",
        );
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to poll due workflows");
  }
}

async function startupRecovery(adapter: PlatformAdapter): Promise<void> {
  // Clean up stale "running" logs from crashed executions first
  try {
    const count = await resetStaleRunningLogs();
    if (count > 0) {
      logger.info({ count }, "Reset stale running workflow logs");
    }
  } catch (error) {
    logger.error({ error }, "Failed to reset stale workflow logs");
  }

  // Then run any due workflows
  await runDueWorkflows(adapter);
}

export function startWorkflowScheduler(adapter: PlatformAdapter): () => void {
  // Startup recovery: await stale reset before first poll
  void startupRecovery(adapter);

  interval = setInterval(() => void runDueWorkflows(adapter), POLL_INTERVAL_MS);
  interval.unref();

  logger.info("Workflow scheduler started");

  return () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    logger.info("Workflow scheduler stopped");
  };
}
