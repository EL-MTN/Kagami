import { tool } from "ai";
import { z } from "zod";
import {
  createRoutine,
  listRoutinesForChat,
  getRoutineById,
  updateRoutine,
  deleteRoutine,
  isDuplicateKeyError,
} from "@mashiro/db";
import { logger, computeNextRunAt, validateCronAndDefaults } from "@mashiro/shared";

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

export function createManageRoutinesTool(chatId: string) {
  return tool({
    description:
      "Manage reusable routines. Create, list, update, delete, enable, or disable routines — named capabilities with optional parameters and optional cron schedules.",
    inputSchema: z.object({
      action: z.enum(["create", "list", "update", "delete", "enable", "disable"]),
      routineId: z
        .string()
        .optional()
        .describe("Routine ID (required for update/delete/enable/disable)"),
      name: z
        .string()
        .optional()
        .describe("Unique routine name (required for create, used as identifier)"),
      description: z
        .string()
        .optional()
        .describe(
          "What this routine does — shown when listing available routines (required for create)",
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
        .describe("Typed parameters the routine accepts"),
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
      purity: z
        .enum(["read", "action"])
        .optional()
        .describe(
          "'read' = routine only observes (search, summarize, query). Safe for watchers. 'action' = routine mutates external state (sends, writes, modifies). Watchers cannot invoke action routines. Optional on create — defaults to 'action' if omitted, the conservative choice.",
        ),
    }),
    execute: async ({
      action,
      routineId,
      name,
      description,
      prompt,
      parameters,
      cronSchedule,
      reportMode,
      purity,
    }) => {
      try {
        switch (action) {
          case "create": {
            if (!name || !description || !prompt || !reportMode) {
              return {
                success: false,
                reason:
                  "name, description, prompt, and reportMode are required to create a routine",
              };
            }

            const cronError = validateCronAndDefaults(cronSchedule, parameters ?? []);
            if (cronError) return { success: false, reason: cronError.message };

            const resolvedPurity = purity ?? "action";

            logger.info(
              { chatId, name, cronSchedule, reportMode, purity: resolvedPurity },
              "Tool: manageRoutines (create)",
            );

            const nextRunAt = cronSchedule ? computeNextRunAt(cronSchedule) : null;

            const routine = await createRoutine(chatId, {
              name,
              description,
              prompt,
              parameters: parameters ?? [],
              cronSchedule: cronSchedule ?? null,
              reportMode,
              purity: resolvedPurity,
              nextRunAt,
            });
            return {
              success: true,
              routineId: routine._id,
              name,
              description,
              cronSchedule: cronSchedule ?? null,
              reportMode,
              purity: resolvedPurity,
              parameterCount: (parameters ?? []).length,
              nextRunAt: nextRunAt?.toISOString() ?? null,
            };
          }

          case "list": {
            logger.info({ chatId }, "Tool: manageRoutines (list)");
            const routines = await listRoutinesForChat(chatId);
            return {
              success: true,
              count: routines.length,
              routines: routines.map((s) => ({
                id: s._id,
                name: s.name,
                description: s.description,
                prompt: s.prompt,
                parameters: s.parameters,
                cronSchedule: s.cronSchedule,
                reportMode: s.reportMode,
                purity: s.purity,
                enabled: s.enabled,
                version: s.version,
                nextRunAt: s.nextRunAt?.toISOString() ?? null,
              })),
            };
          }

          case "update": {
            if (!routineId) {
              return { success: false, reason: "routineId is required for update" };
            }
            logger.info({ routineId }, "Tool: manageRoutines (update)");

            const existing = await getRoutineById(routineId, chatId);
            if (!existing) {
              return { success: false, reason: "Routine not found" };
            }

            const patch: Record<string, unknown> = {};
            if (name) patch.name = name;
            if (description) patch.description = description;
            if (prompt) patch.prompt = prompt;
            if (reportMode) patch.reportMode = reportMode;
            if (purity !== undefined) patch.purity = purity;
            if (parameters) patch.parameters = parameters;

            if (cronSchedule !== undefined) {
              if (cronSchedule) {
                const cronErr = validateCronAndDefaults(
                  cronSchedule,
                  parameters ?? existing.parameters,
                );
                if (cronErr) return { success: false, reason: cronErr.message };

                patch.cronSchedule = cronSchedule;
                patch.nextRunAt = computeNextRunAt(cronSchedule);
              } else {
                patch.cronSchedule = null;
                patch.nextRunAt = null;
              }
            }

            // Increment version on any update
            patch.version = existing.version + 1;

            const updated = await updateRoutine(routineId, patch, chatId);
            return updated
              ? { success: true, routineId, version: updated.version, updated: Object.keys(patch) }
              : { success: false, reason: "Routine not found" };
          }

          case "delete": {
            if (!routineId) {
              return { success: false, reason: "routineId is required for delete" };
            }
            logger.info({ routineId }, "Tool: manageRoutines (delete)");
            const deleted = await deleteRoutine(routineId, chatId);
            return deleted
              ? { success: true, deleted: routineId }
              : { success: false, reason: "Routine not found" };
          }

          case "enable": {
            if (!routineId) {
              return { success: false, reason: "routineId is required for enable" };
            }
            logger.info({ routineId }, "Tool: manageRoutines (enable)");
            const enabled = await updateRoutine(routineId, { enabled: true }, chatId);
            return enabled
              ? { success: true, routineId, enabled: true }
              : { success: false, reason: "Routine not found" };
          }

          case "disable": {
            if (!routineId) {
              return { success: false, reason: "routineId is required for disable" };
            }
            logger.info({ routineId }, "Tool: manageRoutines (disable)");
            const disabled = await updateRoutine(routineId, { enabled: false }, chatId);
            return disabled
              ? { success: true, routineId, enabled: false }
              : { success: false, reason: "Routine not found" };
          }
        }
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return { success: false, reason: `A routine named "${name}" already exists` };
        }
        logger.error({ error, action }, "Tool: manageRoutines failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Routine operation failed",
        };
      }
    },
  });
}
