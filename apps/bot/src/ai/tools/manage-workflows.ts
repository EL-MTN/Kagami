import { tool } from "ai";
import { z } from "zod";
import {
  createWorkflow,
  listWorkflowsForChat,
  getWorkflowById,
  updateWorkflow,
  deleteWorkflow,
} from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { computeNextRunAt, isValidCron } from "../../services/cron.js";
import { executeWorkflow } from "../../services/workflow-executor.js";

export function createManageWorkflowsTool(chatId: string, adapter: PlatformAdapter) {
  return tool({
    description:
      "Manage automated workflows. Create, list, update, delete, enable/disable, or trigger workflows that run on a cron schedule.",
    parameters: z.object({
      action: z.enum(["create", "list", "update", "delete", "enable", "disable", "trigger"]),
      workflowId: z
        .string()
        .optional()
        .describe("Workflow ID (required for update/delete/enable/disable/trigger)"),
      name: z.string().optional().describe("Workflow name (required for create)"),
      prompt: z
        .string()
        .optional()
        .describe("Natural language task description (required for create)"),
      cronSchedule: z
        .string()
        .optional()
        .describe(
          "Cron expression for scheduling, e.g. '0 9 * * *' for daily at 9am (required for create)",
        ),
      reportMode: z
        .enum(["always", "alert"])
        .optional()
        .describe(
          "'always' sends full summary every run, 'alert' only messages on failures/noteworthy events (required for create)",
        ),
    }),
    execute: async ({ action, workflowId, name, prompt, cronSchedule, reportMode }) => {
      try {
        switch (action) {
          case "create": {
            if (!name || !prompt || !cronSchedule || !reportMode) {
              return {
                success: false,
                reason:
                  "name, prompt, cronSchedule, and reportMode are required to create a workflow",
              };
            }
            if (!isValidCron(cronSchedule)) {
              return { success: false, reason: `Invalid cron expression: "${cronSchedule}"` };
            }
            logger.info(
              { chatId, name, cronSchedule, reportMode },
              "Tool: manageWorkflows (create)",
            );
            const nextRunAt = computeNextRunAt(cronSchedule);
            const workflow = await createWorkflow(chatId, {
              name,
              prompt,
              cronSchedule,
              reportMode,
              nextRunAt,
            });
            return {
              success: true,
              workflowId: workflow._id,
              name,
              cronSchedule,
              reportMode,
              nextRunAt: nextRunAt.toISOString(),
            };
          }

          case "list": {
            logger.info({ chatId }, "Tool: manageWorkflows (list)");
            const workflows = await listWorkflowsForChat(chatId);
            return {
              success: true,
              count: workflows.length,
              workflows: workflows.map((w) => ({
                id: w._id,
                name: w.name,
                prompt: w.prompt,
                cronSchedule: w.cronSchedule,
                reportMode: w.reportMode,
                enabled: w.enabled,
                nextRunAt: w.nextRunAt.toISOString(),
              })),
            };
          }

          case "update": {
            if (!workflowId) {
              return { success: false, reason: "workflowId is required for update" };
            }
            logger.info({ workflowId }, "Tool: manageWorkflows (update)");
            const patch: Record<string, unknown> = {};
            if (name) patch.name = name;
            if (prompt) patch.prompt = prompt;
            if (reportMode) patch.reportMode = reportMode;
            if (cronSchedule) {
              if (!isValidCron(cronSchedule)) {
                return { success: false, reason: `Invalid cron expression: "${cronSchedule}"` };
              }
              patch.cronSchedule = cronSchedule;
              patch.nextRunAt = computeNextRunAt(cronSchedule);
            }
            const updated = await updateWorkflow(workflowId, patch, chatId);
            return updated
              ? { success: true, workflowId, updated: Object.keys(patch) }
              : { success: false, reason: "Workflow not found" };
          }

          case "delete": {
            if (!workflowId) {
              return { success: false, reason: "workflowId is required for delete" };
            }
            logger.info({ workflowId }, "Tool: manageWorkflows (delete)");
            const deleted = await deleteWorkflow(workflowId, chatId);
            return deleted
              ? { success: true, deleted: workflowId }
              : { success: false, reason: "Workflow not found" };
          }

          case "enable": {
            if (!workflowId) {
              return { success: false, reason: "workflowId is required for enable" };
            }
            logger.info({ workflowId }, "Tool: manageWorkflows (enable)");
            const enabled = await updateWorkflow(workflowId, { enabled: true }, chatId);
            return enabled
              ? { success: true, workflowId, enabled: true }
              : { success: false, reason: "Workflow not found" };
          }

          case "disable": {
            if (!workflowId) {
              return { success: false, reason: "workflowId is required for disable" };
            }
            logger.info({ workflowId }, "Tool: manageWorkflows (disable)");
            const disabled = await updateWorkflow(workflowId, { enabled: false }, chatId);
            return disabled
              ? { success: true, workflowId, enabled: false }
              : { success: false, reason: "Workflow not found" };
          }

          case "trigger": {
            if (!workflowId) {
              return { success: false, reason: "workflowId is required for trigger" };
            }
            const workflow = await getWorkflowById(workflowId, chatId);
            if (!workflow) {
              return { success: false, reason: "Workflow not found" };
            }
            logger.info({ workflowId, name: workflow.name }, "Tool: manageWorkflows (trigger)");
            // Fire-and-forget — don't block the tool response. Don't advance schedule.
            void executeWorkflow(workflow, adapter, { advanceSchedule: false }).catch((error) => {
              logger.error({ error, workflowId }, "Manual workflow trigger failed");
            });
            return {
              success: true,
              workflowId,
              name: workflow.name,
              message: "Workflow is running now. I'll report back when it's done.",
            };
          }
        }
      } catch (error) {
        logger.error({ error, action }, "Tool: manageWorkflows failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Workflow operation failed",
        };
      }
    },
  });
}
