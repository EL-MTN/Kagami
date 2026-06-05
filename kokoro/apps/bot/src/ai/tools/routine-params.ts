import { z, type ZodTypeAny } from "zod";
import type { IRoutineParameter, RoutineParameterType } from "@kokoro/db";

// Leaf module (zod + type-only db imports) holding the runtime coercion/
// validation for routine parameters. Lives apart from `routines.ts` so both
// `useRoutine` and `delegate` (routine-backed sub-tasks) can re-validate
// against the exact same shape without pulling the routine-executor import
// graph — and its heavier transitive deps — into either caller.

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

const typeSchemas: Record<RoutineParameterType, ZodTypeAny> = {
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

function buildParamSchema(schema: IRoutineParameter[]): z.ZodType<Record<string, unknown>> {
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

export function validateParameters(
  params: Record<string, unknown> | undefined,
  schema: IRoutineParameter[],
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
