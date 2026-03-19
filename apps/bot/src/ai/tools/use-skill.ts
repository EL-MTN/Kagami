import { tool } from "ai";
import { z } from "zod";
import { getSkillByName, type ISkillParameter } from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { executeSkill, MAX_SKILL_DEPTH } from "../../services/skill-executor";

function validateParameters(
  params: Record<string, unknown> | undefined,
  schema: ISkillParameter[],
): { valid: true; resolved: Record<string, unknown> } | { valid: false; reason: string } {
  const resolved: Record<string, unknown> = {};

  for (const param of schema) {
    const value = params?.[param.name];

    if (value === undefined || value === null) {
      if (param.required) {
        if (param.default !== undefined) {
          resolved[param.name] = param.default;
        } else {
          return { valid: false, reason: `Missing required parameter: "${param.name}"` };
        }
      } else if (param.default !== undefined) {
        resolved[param.name] = param.default;
      }
      continue;
    }

    // Type check
    const actualType = typeof value;
    if (param.type === "string" && actualType !== "string") {
      resolved[param.name] = `${value as string | number | boolean}`;
    } else if (param.type === "number" && actualType !== "number") {
      const num = Number(value);
      if (isNaN(num)) {
        return { valid: false, reason: `Parameter "${param.name}" must be a number` };
      }
      resolved[param.name] = num;
    } else if (param.type === "boolean" && actualType !== "boolean") {
      resolved[param.name] = value === "true" || value === true || value === 1;
    } else {
      resolved[param.name] = value;
    }
  }

  // Pass through any extra parameters not in schema
  if (params) {
    for (const key of Object.keys(params)) {
      if (!(key in resolved)) {
        resolved[key] = params[key];
      }
    }
  }

  return { valid: true, resolved };
}

export function createUseSkillTool(chatId: string, adapter: PlatformAdapter, depth = 0) {
  return tool({
    description:
      "Invoke a skill by name with optional parameters. The skill executes as a separate LLM call and returns its result synchronously.",
    inputSchema: z.object({
      skillName: z.string().describe("Name of the skill to invoke"),
      parameters: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("Key-value parameters to pass to the skill"),
    }),
    execute: async ({ skillName, parameters }) => {
      try {
        // Check recursion depth
        if (depth >= MAX_SKILL_DEPTH) {
          return {
            success: false,
            reason: `Maximum skill depth (${MAX_SKILL_DEPTH}) reached — cannot invoke nested skills further`,
          };
        }

        const skill = await getSkillByName(chatId, skillName);
        if (!skill) {
          return { success: false, reason: `Skill "${skillName}" not found` };
        }
        if (!skill.enabled) {
          return { success: false, reason: `Skill "${skillName}" is disabled` };
        }

        // Validate parameters
        const validation = validateParameters(parameters, skill.parameters);
        if (!validation.valid) {
          return { success: false, reason: validation.reason };
        }

        logger.info(
          { chatId, skillName, depth, paramCount: Object.keys(validation.resolved).length },
          "Tool: useSkill",
        );

        const result = await executeSkill(skill, adapter, {
          trigger: "skill",
          parameters: validation.resolved,
          depth: depth + 1,
        });

        return {
          success: true,
          skillName,
          result,
        };
      } catch (error) {
        logger.error({ error, skillName }, "Tool: useSkill failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Skill invocation failed",
        };
      }
    },
  });
}
