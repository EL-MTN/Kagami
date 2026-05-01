import { tool } from "ai";
import { z, type ZodTypeAny } from "zod";
import { getSkillByName, type ISkillParameter, type SkillParameterType } from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { executeSkill, MAX_SKILL_DEPTH } from "../../services/skill-executor";

const jsonArrayFromString = z.string().transform((s, ctx) => {
  try {
    const parsed: unknown = JSON.parse(s);
    if (!Array.isArray(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected an array" });
      return z.NEVER;
    }
    return parsed as unknown[];
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid JSON" });
    return z.NEVER;
  }
});

const jsonObjectFromString = z.string().transform((s, ctx) => {
  try {
    const parsed: unknown = JSON.parse(s);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected an object" });
      return z.NEVER;
    }
    return parsed as Record<string, unknown>;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid JSON" });
    return z.NEVER;
  }
});

const typeSchemas: Record<SkillParameterType, ZodTypeAny> = {
  // Accept string|number|boolean and stringify — preserves the original
  // hand-rolled validator's tolerance for LLMs returning `42` or `true` for
  // a string-typed param. Plain `z.coerce.string()` would silently coerce
  // `undefined` to the literal "undefined" so a missing required string
  // would slip through; the union rejects undefined cleanly because none of
  // its member types accept it.
  string: z.union([z.string(), z.number(), z.boolean()]).transform(String),
  number: z.coerce.number(),
  boolean: z.coerce.boolean(),
  array: z.array(z.unknown()).or(jsonArrayFromString),
  object: z.record(z.string(), z.unknown()).or(jsonObjectFromString),
};

function buildParamSchema(schema: ISkillParameter[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, ZodTypeAny> = {};
  const defaults: Record<string, unknown> = {};

  for (const param of schema) {
    let field = typeSchemas[param.type] ?? z.unknown();

    if (param.default !== undefined) {
      // Defaults are filled in at the object level (see preprocess below)
      // so the value flows through the per-field type schema's coercion
      // — e.g. a number-typed param with `default: "10"` gets coerced to
      // 10. `field.default(value)` would short-circuit Zod 4's pipeline,
      // and a per-field `z.preprocess` runs too late: Zod 4.4+'s z.object
      // raises `nonoptional` for missing required keys before any inner
      // preprocess gets the input.
      defaults[param.name] = param.default;
    } else if (!param.required) {
      field = field.optional();
    }

    shape[param.name] = field;
  }

  const baseSchema = z.object(shape).passthrough();

  if (Object.keys(defaults).length === 0) return baseSchema;

  return z.preprocess((input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (!(key in obj)) out[key] = defaultValue;
    }
    return out;
  }, baseSchema);
}

function validateParameters(
  params: Record<string, unknown> | undefined,
  schema: ISkillParameter[],
): { valid: true; resolved: Record<string, unknown> } | { valid: false; reason: string } {
  const zodSchema = buildParamSchema(schema);
  const result = zodSchema.safeParse(params ?? {});

  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.length > 0 ? `"${first.path.join(".")}"` : "input";
    return { valid: false, reason: `Parameter ${path}: ${first.message}` };
  }

  return { valid: true, resolved: result.data };
}

export type UseSkillCallingContext = "main" | "watcher";

export function createUseSkillTool(
  chatId: string,
  adapter: PlatformAdapter,
  depth = 0,
  callingContext: UseSkillCallingContext = "main",
) {
  return tool({
    description:
      callingContext === "watcher"
        ? 'Invoke a read-purity skill by name. Watchers can only invoke skills marked `purity: "read"` — action skills (sends, writes, mutations) are rejected. The skill executes as a separate LLM call and returns its result synchronously.'
        : "Invoke a skill by name with optional parameters. The skill executes as a separate LLM call and returns its result synchronously.",
    inputSchema: z.object({
      skillName: z.string().describe("Name of the skill to invoke"),
      parameters: z
        .record(z.string(), z.unknown())
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

        // Watchers may only invoke read-purity skills.
        if (callingContext === "watcher" && skill.purity !== "read") {
          return {
            success: false,
            reason: `Skill "${skillName}" has purity "${skill.purity}" and cannot be invoked from a watcher. Watchers can only call skills marked purity: "read".`,
          };
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
          // Propagate the gate so a watcher → read-purity skill chain cannot
          // call into action-purity skills on a deeper hop.
          callingContext,
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
