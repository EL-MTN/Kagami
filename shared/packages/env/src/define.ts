import { z } from "zod";
import type {
  DefineEnvOptions,
  EnvSpec,
  OnInvalid,
  ParseOptions,
  VarInfo,
  VarMeta,
  WarnEvent,
} from "./types.js";

function readMeta(schema: z.ZodType): VarMeta | undefined {
  return schema.meta() as VarMeta | undefined;
}

/** Render a parsed (post-transform) default for display in generated artifacts. */
function renderDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function introspect(key: string, schema: z.ZodType, meta: VarMeta): VarInfo {
  const probe = schema.safeParse(undefined);
  if (!probe.success) return { key, meta, required: true };
  return { key, meta, required: false, defaultValue: renderDefault(probe.data) };
}

function formatIssueLines(lines: string[]): string {
  return lines.map((line) => `  - ${line}`).join("\n");
}

const HEADER = "Invalid environment configuration:";

function failHard(lines: string[], mode: Extract<OnInvalid, "throw" | "exit">): never {
  const message = `${HEADER}\n${formatIssueLines(lines)}`;
  if (mode === "exit") {
    console.error(message);
    process.exit(1);
  }
  throw new Error(message);
}

export function defineEnv<Shape extends z.ZodRawShape>(
  options: DefineEnvOptions<Shape>,
): EnvSpec<z.output<z.ZodObject<Shape>>> {
  type Output = z.output<z.ZodObject<Shape>>;

  const blankAsUndefined = options.emptyStringAsUndefined ?? true;
  const requireDocs = options.requireDocs ?? true;
  const aliases = options.aliases ?? {};
  const objectSchema = z.object(options.vars);
  const varSchemas = new Map<string, z.ZodType>(
    Object.entries(options.vars) as Array<[string, z.ZodType]>,
  );

  const keys: VarInfo[] = [];
  for (const [key, schema] of varSchemas) {
    const meta = readMeta(schema);
    if (requireDocs && !meta?.doc?.trim()) {
      throw new Error(
        `@kagami/env: ${options.service}/${options.component} declares ${key} without .meta({ doc: ... }) — every var documents itself, or set requireDocs: false`,
      );
    }
    keys.push(introspect(key, schema, meta ?? { doc: "" }));
  }

  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!varSchemas.has(canonical)) {
      throw new Error(
        `@kagami/env: alias ${alias} points at undeclared key ${canonical} in ${options.service}/${options.component}`,
      );
    }
    if (varSchemas.has(alias)) {
      throw new Error(
        `@kagami/env: alias ${alias} collides with a declared key in ${options.service}/${options.component}`,
      );
    }
  }

  const normalize = (raw: string | undefined): string | undefined => {
    if (raw === undefined || !blankAsUndefined) return raw;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  };

  /**
   * Copy ONLY declared keys (plus alias resolution) out of the raw env.
   * This allowlist-by-construction is also the seam the future `.env.shared`
   * loader injects through — undeclared keys can never reach a parse.
   */
  const buildRecord = (env: Record<string, string | undefined>): Record<string, string> => {
    const record: Record<string, string> = {};
    for (const key of varSchemas.keys()) {
      const value = normalize(env[key]);
      if (value !== undefined) record[key] = value;
    }
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (record[canonical] !== undefined) continue;
      const value = normalize(env[alias]);
      if (value !== undefined) record[canonical] = value;
    }
    return record;
  };

  const parse = (env: Record<string, string | undefined>, parseOptions?: ParseOptions): Output => {
    const mode = parseOptions?.onInvalid ?? "throw";
    const onWarn =
      parseOptions?.onWarn ??
      ((warning: WarnEvent) => {
        const meta = readMeta(varSchemas.get(warning.key) as z.ZodType);
        const provided = meta?.secret ? "<redacted>" : warning.provided;
        console.warn(
          `@kagami/env: ${warning.key} invalid (${warning.message}); provided ${JSON.stringify(provided)}, using default`,
        );
      });

    const record = buildRecord(env);
    let result = objectSchema.safeParse(record);
    const warnings: WarnEvent[] = [];

    if (!result.success) {
      const hard: string[] = [];
      for (const issue of result.error.issues) {
        const key = typeof issue.path[0] === "string" ? issue.path[0] : "";
        const schema = key ? varSchemas.get(key) : undefined;
        const policy = (schema ? readMeta(schema)?.onInvalid : undefined) ?? mode;
        const provided = key ? record[key] : undefined;
        if (policy === "warn-default" && schema && provided !== undefined) {
          warnings.push({ key, provided, message: issue.message });
          delete record[key];
        } else {
          hard.push(`${key || issue.path.join(".") || "(root)"}: ${issue.message}`);
        }
      }
      if (hard.length > 0) failHard(hard, mode);
      // Every issue was absorbed by a warn-default key — re-parse without them.
      result = objectSchema.safeParse(record);
    }

    if (!result.success) {
      // A warn-default key without a usable default — surface it plainly.
      failHard(
        result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
        mode,
      );
    }

    for (const warning of warnings) onWarn(warning);

    const config: Output = result.data;

    if ((parseOptions?.cross ?? "run") === "run" && options.cross?.length) {
      const crossIssues = options.cross.flatMap((check) => check(config));
      if (crossIssues.length > 0) failHard(crossIssues, mode);
    }

    return config;
  };

  return {
    service: options.service,
    component: options.component,
    keyNames: [...varSchemas.keys()],
    keys,
    aliases,
    parse,
  };
}
