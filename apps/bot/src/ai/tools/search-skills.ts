import { tool } from "ai";
import { z } from "zod";
import { listSkillsForChat, type ISkill } from "@mashiro/db";
import { logger } from "@mashiro/shared";

function matchesQuery(skill: ISkill, terms: string[]): boolean {
  const haystack = `${skill.name} ${skill.description}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export function createSearchSkillsTool(chatId: string) {
  return tool({
    description:
      "Search available skills by keyword. Returns matching skills with their descriptions, parameters, and schedules. Call with no query to list all skills.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe("Search keywords to match against skill names and descriptions"),
    }),
    execute: async ({ query }) => {
      try {
        const skills = await listSkillsForChat(chatId);
        const enabled = skills.filter((s) => s.enabled);

        if (enabled.length === 0) {
          return { success: true, count: 0, skills: [], hint: "No skills exist yet" };
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
          "Tool: searchSkills",
        );

        return {
          success: true,
          count: matches.length,
          skills: matches.map((s) => ({
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
          })),
        };
      } catch (error) {
        logger.error({ error }, "Tool: searchSkills failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Skill search failed",
        };
      }
    },
  });
}
