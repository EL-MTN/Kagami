import { tool } from "ai";
import { z } from "zod";
import { listRoutinesForChat, type IRoutine } from "@mashiro/db";
import { logger } from "@mashiro/shared";

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
        logger.error({ error }, "Tool: searchRoutines failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Routine search failed",
        };
      }
    },
  });
}
