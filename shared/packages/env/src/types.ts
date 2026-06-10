import type { z } from "zod";

/**
 * Per-key invalid-value policy.
 *
 * - `"throw"` — aggregate issues into a thrown Error (the Kizuna/Kao
 *   `loadConfig` contract).
 * - `"exit"` — print issues and `process.exit(1)` (the Kokoro module-scope
 *   contract).
 * - `"warn-default"` — report the bad value through `onWarn` and fall back to
 *   the schema default (the Kioku/Kansoku "operator typo is never silently
 *   absorbed, but never crashes boot" contract). Only valid on keys that have
 *   a default; a warn-default key without one escalates to a hard issue.
 *
 * `"throw"`/`"exit"` are call-level modes (`ParseOptions.onInvalid`);
 * `"warn-default"` is set per key via `VarMeta.onInvalid`.
 */
export type OnInvalid = "throw" | "exit" | "warn-default";

/**
 * Metadata attached to each env-var schema via zod's native `.meta()`.
 * This is the single source the generators read — `.env.example` comments,
 * doc-table rows, and turbo.json env declarations are all derived from it.
 *
 * `.meta()` must be the LAST call on the composed schema (it registers
 * against that exact schema instance; a later `.optional()`/`.default()`
 * returns a new instance without the registration).
 */
export interface VarMeta {
  /**
   * Prose for generated artifacts. The first line becomes the doc-table
   * "Purpose" cell; the full text becomes the `.env.example` comment block.
   * Line breaks are preserved verbatim — wrap lines yourself.
   */
  doc: string;
  /**
   * Value displayed in `.env.example`. Required when the schema's parsed
   * default is not a valid raw env string (e.g. transform outputs like
   * arrays); also used to show a suggested value for required vars.
   */
  example?: string;
  /** Render blank in `.env.example`, mask in tooling output, seed the future redaction list. */
  secret?: boolean;
  /**
   * Render uncommented in `.env.example` even when optional — for knobs the
   * template should ship turned on (e.g. provider endpoints that are optional
   * at boot but required for the service to be useful).
   */
  recommended?: boolean;
  /** Eligible for workspace-level `.env.shared` injection (default false). */
  sharedAllowed?: boolean;
  /** Include this var in the ARCHITECTURE.md cross-service cheat sheet. */
  crossService?: boolean;
  /** Only meaningful outside Portless (standalone bind host/port fallbacks). */
  standaloneOnly?: boolean;
  /** Section heading in `.env.example`; consecutive vars with the same group render under one header. */
  group?: string;
  /** Per-key invalid-value policy override. See {@link OnInvalid}. */
  onInvalid?: OnInvalid;
}

/** Introspected shape of one declared var, computed once at define time. */
export interface VarInfo {
  key: string;
  meta: VarMeta;
  /** True when parsing `undefined` fails — i.e. no default and not optional. */
  required: boolean;
  /** Rendered schema default (post-transform), when one exists. */
  defaultValue?: string;
}

/** A bad value absorbed by a `warn-default` key. */
export interface WarnEvent {
  key: string;
  /** The raw provided value. Never logged by the package itself for secret keys. */
  provided: string;
  message: string;
}

export interface ParseOptions {
  /**
   * Call-level hard-issue mode: `"throw"` (default) or `"exit"`.
   * (`"warn-default"` is a per-key policy and is ignored here.)
   */
  onInvalid?: Extract<OnInvalid, "throw" | "exit">;
  /** Receives each warn-default absorption. Defaults to `console.warn`. */
  onWarn?: (warning: WarnEvent) => void;
  /**
   * Whether to run the spec's cross-field checks. Consumers that only need a
   * subset of the config (e.g. a dashboard that reads MONGODB_URI but never
   * touches the LLM keys) parse with `"skip"`.
   */
  cross?: "run" | "skip";
}

export interface DefineEnvOptions<Shape extends z.ZodRawShape> {
  /** Owning service, e.g. `"kao"`. Used in generated headers. */
  service: string;
  /** Owning app/component, e.g. `"api"`. */
  component: string;
  /** Declaration order is preserved in every generated artifact. */
  vars: Shape;
  /**
   * Cross-field checks run after a structurally valid parse. Each returns
   * human-readable issue strings ([] = pass). Compose shared blocks' checks
   * by spreading them in.
   */
  cross?: ReadonlyArray<(config: z.output<z.ZodObject<Shape>>) => string[]>;
  /**
   * Legacy alias map, alias → canonical. When the canonical key is unset and
   * the alias is set, the alias value is used (e.g. Kioku's `MODEL` →
   * `LLM_MODEL` kept alive for the longmemeval bench).
   */
  aliases?: Record<string, string>;
  /**
   * Treat empty/whitespace-only values as unset and trim kept values before
   * parsing (default true). This is the `blankAsUndefined` preprocess that
   * was previously hand-duplicated per var in Kokoro/Kizuna/Kao, applied
   * uniformly at the record level.
   */
  emptyStringAsUndefined?: boolean;
  /**
   * Enforce that every var carries `.meta({ doc })` (default true). Spikes
   * and incremental migrations may opt out.
   */
  requireDocs?: boolean;
}

export interface EnvSpec<Output> {
  service: string;
  component: string;
  /** Declared key names in declaration order. */
  keyNames: string[];
  /** Introspected per-var info in declaration order (generator input). */
  keys: VarInfo[];
  aliases: Record<string, string>;
  /** Parse and validate an env record. See {@link ParseOptions}. */
  parse(env: Record<string, string | undefined>, options?: ParseOptions): Output;
}

/** Output type of a spec — `type Config = EnvOutput<typeof envSpec>`. */
export type EnvOutput<Spec> = Spec extends EnvSpec<infer Output> ? Output : never;
