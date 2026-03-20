import { tool } from "ai";
import { z } from "zod";
import {
  createSkill,
  listSkillsForChat,
  getSkillById,
  updateSkill,
  deleteSkill,
  isDuplicateKeyError,
  type ISkillParameter,
} from "@mashiro/db";
import { logger } from "@mashiro/shared";
import { computeNextRunAt, isValidCron } from "../../services/cron";

function validateCronParams(
  cronSchedule: string | undefined,
  params: ISkillParameter[],
): string | null {
  if (!cronSchedule) return null;
  if (!isValidCron(cronSchedule)) return `Invalid cron expression: "${cronSchedule}"`;
  const missing = params.filter((p) => p.required && p.default === undefined);
  if (missing.length > 0) {
    return `Cron-scheduled skills require defaults for all required parameters. Missing defaults: ${missing.map((p) => p.name).join(", ")}`;
  }
  return null;
}

const parameterSchema = z.object({
  name: z.string().describe("Parameter name"),
  type: z
    .enum(["string", "number", "boolean", "array", "object"])
    .describe("Parameter type — use array for lists, object for key-value maps"),
  description: z.string().describe("What this parameter is for"),
  required: z.boolean().describe("Whether this parameter must be provided"),
  default: z
    .unknown()
    .optional()
    .describe("Default value (required params with cron schedules must have defaults)"),
});

export function createManageSkillsTool(chatId: string) {
  return tool({
    description:
      "Manage reusable skills. Create, list, update, delete, enable, or disable skills — named capabilities with optional parameters and optional cron schedules.",
    inputSchema: z.object({
      action: z.enum(["create", "list", "update", "delete", "enable", "disable"]),
      skillId: z
        .string()
        .optional()
        .describe("Skill ID (required for update/delete/enable/disable)"),
      name: z
        .string()
        .optional()
        .describe("Unique skill name (required for create, used as identifier)"),
      description: z
        .string()
        .optional()
        .describe(
          "What this skill does — shown when listing available skills (required for create)",
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          "Execution instructions — the task description that runs as an LLM call (required for create)",
        ),
      parameters: z
        .array(parameterSchema)
        .optional()
        .describe("Typed parameters the skill accepts"),
      cronSchedule: z
        .string()
        .optional()
        .describe("Cron expression for automatic scheduling (omit for on-demand only)"),
      reportMode: z
        .enum(["always", "alert"])
        .optional()
        .describe(
          "'always' sends summary every run, 'alert' only on failures/noteworthy events (required for create)",
        ),
    }),
    execute: async ({
      action,
      skillId,
      name,
      description,
      prompt,
      parameters,
      cronSchedule,
      reportMode,
    }) => {
      try {
        switch (action) {
          case "create": {
            if (!name || !description || !prompt || !reportMode) {
              return {
                success: false,
                reason: "name, description, prompt, and reportMode are required to create a skill",
              };
            }

            const cronError = validateCronParams(
              cronSchedule,
              (parameters ?? []) as ISkillParameter[],
            );
            if (cronError) return { success: false, reason: cronError };

            logger.info({ chatId, name, cronSchedule, reportMode }, "Tool: manageSkills (create)");

            const nextRunAt = cronSchedule ? computeNextRunAt(cronSchedule) : null;

            const skill = await createSkill(chatId, {
              name,
              description,
              prompt,
              parameters: (parameters ?? []) as ISkillParameter[],
              cronSchedule: cronSchedule ?? null,
              reportMode,
              nextRunAt,
            });
            return {
              success: true,
              skillId: skill._id,
              name,
              description,
              cronSchedule: cronSchedule ?? null,
              reportMode,
              parameterCount: (parameters ?? []).length,
              nextRunAt: nextRunAt?.toISOString() ?? null,
            };
          }

          case "list": {
            logger.info({ chatId }, "Tool: manageSkills (list)");
            const skills = await listSkillsForChat(chatId);
            return {
              success: true,
              count: skills.length,
              skills: skills.map((s) => ({
                id: s._id,
                name: s.name,
                description: s.description,
                prompt: s.prompt,
                parameters: s.parameters,
                cronSchedule: s.cronSchedule,
                reportMode: s.reportMode,
                enabled: s.enabled,
                version: s.version,
                nextRunAt: s.nextRunAt?.toISOString() ?? null,
              })),
            };
          }

          case "update": {
            if (!skillId) {
              return { success: false, reason: "skillId is required for update" };
            }
            logger.info({ skillId }, "Tool: manageSkills (update)");

            const existing = await getSkillById(skillId, chatId);
            if (!existing) {
              return { success: false, reason: "Skill not found" };
            }

            const patch: Record<string, unknown> = {};
            if (name) patch.name = name;
            if (description) patch.description = description;
            if (prompt) patch.prompt = prompt;
            if (reportMode) patch.reportMode = reportMode;
            if (parameters) patch.parameters = parameters;

            if (cronSchedule !== undefined) {
              if (cronSchedule) {
                const cronErr = validateCronParams(cronSchedule, parameters ?? existing.parameters);
                if (cronErr) return { success: false, reason: cronErr };

                patch.cronSchedule = cronSchedule;
                patch.nextRunAt = computeNextRunAt(cronSchedule);
              } else {
                // Explicitly clearing cron
                patch.cronSchedule = null;
                patch.nextRunAt = null;
              }
            }

            // Increment version on any update
            patch.version = existing.version + 1;

            const updated = await updateSkill(skillId, patch, chatId);
            return updated
              ? { success: true, skillId, version: updated.version, updated: Object.keys(patch) }
              : { success: false, reason: "Skill not found" };
          }

          case "delete": {
            if (!skillId) {
              return { success: false, reason: "skillId is required for delete" };
            }
            logger.info({ skillId }, "Tool: manageSkills (delete)");
            const deleted = await deleteSkill(skillId, chatId);
            return deleted
              ? { success: true, deleted: skillId }
              : { success: false, reason: "Skill not found" };
          }

          case "enable": {
            if (!skillId) {
              return { success: false, reason: "skillId is required for enable" };
            }
            logger.info({ skillId }, "Tool: manageSkills (enable)");
            const enabled = await updateSkill(skillId, { enabled: true }, chatId);
            return enabled
              ? { success: true, skillId, enabled: true }
              : { success: false, reason: "Skill not found" };
          }

          case "disable": {
            if (!skillId) {
              return { success: false, reason: "skillId is required for disable" };
            }
            logger.info({ skillId }, "Tool: manageSkills (disable)");
            const disabled = await updateSkill(skillId, { enabled: false }, chatId);
            return disabled
              ? { success: true, skillId, enabled: false }
              : { success: false, reason: "Skill not found" };
          }
        }
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return { success: false, reason: `A skill named "${name}" already exists` };
        }
        logger.error({ error, action }, "Tool: manageSkills failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Skill operation failed",
        };
      }
    },
  });
}
