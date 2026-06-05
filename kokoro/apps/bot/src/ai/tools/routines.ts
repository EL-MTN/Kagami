import { tool } from "ai";
import { z } from "zod";
import {
  createRoutine,
  listRoutinesForChat,
  getRoutineById,
  getRoutineByName,
  updateRoutine,
  deleteRoutine,
  isDuplicateKeyError,
  type IRoutine,
} from "@kokoro/db";
import { logger, computeNextRunAt, validateCronAndDefaults } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { executeRoutine, MAX_ROUTINE_DEPTH } from "../../services/routine-executor";
import { validateParameters } from "./routine-params";

// ─── manageRoutines ──────────────────────────────────────────────────────────

// parameterSchema lives in the leaf module `./routine-schema` (zod-only, no
// other imports) so the gated `createRoutine` dispatcher and the `proposeRoutine`
// tool can re-validate against the exact same shape without dragging the
// routine-executor import graph into a cycle.
import { parameterSchema } from "./routine-schema";

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

            logger.debug(
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
            logger.debug({ chatId }, "Tool: manageRoutines (list)");
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
            logger.debug({ routineId }, "Tool: manageRoutines (update)");

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
            logger.debug({ routineId }, "Tool: manageRoutines (delete)");
            const deleted = await deleteRoutine(routineId, chatId);
            return deleted
              ? { success: true, deleted: routineId }
              : { success: false, reason: "Routine not found" };
          }

          case "enable": {
            if (!routineId) {
              return { success: false, reason: "routineId is required for enable" };
            }
            logger.debug({ routineId }, "Tool: manageRoutines (enable)");
            const enabled = await updateRoutine(routineId, { enabled: true }, chatId);
            return enabled
              ? { success: true, routineId, enabled: true }
              : { success: false, reason: "Routine not found" };
          }

          case "disable": {
            if (!routineId) {
              return { success: false, reason: "routineId is required for disable" };
            }
            logger.debug({ routineId }, "Tool: manageRoutines (disable)");
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
        logger.error({ error: error, action }, "Tool: manageRoutines failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Routine operation failed",
        };
      }
    },
  });
}

// ─── searchRoutines ──────────────────────────────────────────────────────────

function matchesQuery(routine: IRoutine, terms: string[]): boolean {
  const haystack = `${routine.name} ${routine.description}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export function createSearchRoutinesTool(chatId: string) {
  return tool({
    description:
      "Search available routines by keyword. Returns matching routines with their descriptions, parameters, and schedules. Call with no query to list all routines.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe("Search keywords to match against routine names and descriptions"),
    }),
    execute: async ({ query }) => {
      try {
        const routines = await listRoutinesForChat(chatId);
        const enabled = routines.filter((s) => s.enabled);

        if (enabled.length === 0) {
          return { success: true, count: 0, routines: [], hint: "No routines exist yet" };
        }

        const terms = query
          ? query
              .toLowerCase()
              .split(/\s+/)
              .filter((t) => t.length > 0)
          : [];

        const matches = terms.length > 0 ? enabled.filter((s) => matchesQuery(s, terms)) : enabled;

        logger.debug(
          { chatId, query, total: enabled.length, matched: matches.length },
          "Tool: searchRoutines",
        );

        return {
          success: true,
          count: matches.length,
          routines: matches.map((s) => ({
            name: s.name,
            description: s.description,
            parameters:
              s.parameters.length > 0
                ? s.parameters.map((p) => ({
                    name: p.name,
                    type: p.type,
                    required: p.required,
                    description: p.description,
                  }))
                : [],
            cronSchedule: s.cronSchedule ?? null,
            reportMode: s.reportMode,
            purity: s.purity,
          })),
        };
      } catch (error) {
        logger.error({ error: error }, "Tool: searchRoutines failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Routine search failed",
        };
      }
    },
  });
}

// ─── useRoutine ──────────────────────────────────────────────────────────────
// Parameter coercion/validation lives in the leaf `./routine-params` so the
// `delegate` tool can re-validate routine-backed sub-tasks against the same
// shape without re-importing this module's executor graph.

type UseRoutineCallingContext = "main" | "watcher";

export function createUseRoutineTool(
  chatId: string,
  adapter: PlatformAdapter,
  depth = 0,
  callingContext: UseRoutineCallingContext = "main",
) {
  return tool({
    description:
      callingContext === "watcher"
        ? 'Invoke a read-purity routine by name. Watchers can only invoke routines marked `purity: "read"` — action routines (sends, writes, mutations) are rejected. The routine executes as a separate LLM call and returns its result synchronously.'
        : "Invoke a routine by name with optional parameters. The routine executes as a separate LLM call and returns its result synchronously.",
    inputSchema: z.object({
      routineName: z.string().describe("Name of the routine to invoke"),
      parameters: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Key-value parameters to pass to the routine"),
    }),
    execute: async ({ routineName, parameters }) => {
      try {
        // Check recursion depth
        if (depth >= MAX_ROUTINE_DEPTH) {
          return {
            success: false,
            reason: `Maximum routine depth (${MAX_ROUTINE_DEPTH}) reached — cannot invoke nested routines further`,
          };
        }

        const routine = await getRoutineByName(chatId, routineName);
        if (!routine) {
          return { success: false, reason: `Routine "${routineName}" not found` };
        }
        if (!routine.enabled) {
          return { success: false, reason: `Routine "${routineName}" is disabled` };
        }

        // Watchers may only invoke read-purity routines.
        if (callingContext === "watcher" && routine.purity !== "read") {
          return {
            success: false,
            reason: `Routine "${routineName}" has purity "${routine.purity}" and cannot be invoked from a watcher. Watchers can only call routines marked purity: "read".`,
          };
        }

        // Validate parameters
        const validation = validateParameters(parameters, routine.parameters);
        if (!validation.valid) {
          return { success: false, reason: validation.reason };
        }

        logger.debug(
          { chatId, routineName, depth, paramCount: Object.keys(validation.resolved).length },
          "Tool: useRoutine",
        );

        const result = await executeRoutine(routine, adapter, {
          trigger: "routine",
          parameters: validation.resolved,
          depth: depth + 1,
          // Propagate the gate so a watcher → read-purity routine chain cannot
          // call into action-purity routines on a deeper hop.
          callingContext,
        });

        return {
          success: true,
          routineName,
          result,
        };
      } catch (error) {
        logger.error({ error: error, routineName }, "Tool: useRoutine failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Routine invocation failed",
        };
      }
    },
  });
}
