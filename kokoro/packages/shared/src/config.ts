import "dotenv/config";
import { z } from "zod";

const optionalEnabledFlag = z.preprocess(
  (value) => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  },
  z
    .enum(["true", "false"])
    .default("true")
    .transform((s) => s === "true"),
);

// MCP (Model Context Protocol) servers Kokoro connects to as a CLIENT, mounting
// their tools alongside the built-in palette (namespaced `mcp_<server>_<tool>`).
// Configured as a JSON array in MCP_SERVERS; empty / unset → no MCP tools. Each
// server is fail-open at connect time (an unreachable server is logged and
// skipped, never crashes the bot). `http`/`sse` are remote transports; `stdio`
// spawns a local subprocess. Server names are constrained to a tool-name-safe
// charset so the namespacing prefix is collision-free without sanitization.
const mcpServerNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/, "MCP server name must match [a-zA-Z0-9_-]");

const mcpHttpServerSchema = z.object({
  name: mcpServerNameSchema,
  transport: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpStdioServerSchema = z.object({
  name: mcpServerNameSchema,
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

export const mcpServerSchema = z.union([mcpHttpServerSchema, mcpStdioServerSchema]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

const baseSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  ALLOWED_USER_IDS: z
    .string()
    .default("")
    .transform((s) => (s ? s.split(",").map(Number) : [])),

  // Kokoro chat is native-only; LLM_KIND is the explicit canonical marker
  // LLM_PROVIDER/LLM_MODEL are already canonical for
  // native, so no legacy rename here. LLM_MODEL_{FAST,SMART} externalize the
  // previously-hardcoded tier map; unset → provider defaults (unchanged).
  LLM_KIND: z.enum(["native"]).default("native"),
  LLM_PROVIDER: z.enum(["anthropic", "openai", "xai"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-sonnet-4-6"),
  LLM_MODEL_FAST: z.string().optional(),
  LLM_MODEL_SMART: z.string().optional(),
  // Per-attempt deadline for chat calls (the @kagami/llm gateway retries the
  // attempt on timeout). Bounds a hung/slow provider response so it fails over
  // fast instead of eating the whole conversational turn budget. NOT the turn
  // budget itself — that's the per-call-site `LLM_TIMEOUT_MS` constants
  // (generate.ts 120s, acknowledge.ts 60s, watcher/routine 180s). Empty string
  // → default (matches the KANSOKU_URL/KAO_URL empty-handling below). Default 30s.
  LLM_ATTEMPT_TIMEOUT_MS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().positive().default(30_000),
  ),

  XAI_API_KEY: z.string().optional(),

  GOOGLE_API_KEY: z.string().optional(),

  MONGODB_URI: z.string().default("mongodb://localhost:27017/kokoro"),

  KIOKU_URL: z.string().url().default("https://api.kioku.localhost"),
  KIZUNA_URL: z.string().url().default("https://api.kizuna.localhost"),
  KIZUNA_ENABLED: optionalEnabledFlag,

  // Kansoku observability — opt-in via env. Both must be set together; either
  // missing leaves the logger stdout-only. The shipper itself is fail-open.
  // Empty / whitespace-only strings are treated as "missing" so a typo like
  // `KANSOKU_URL=` in .env doesn't crash startup with a Zod .url() error
  // (matching the silent-disable behavior in Kioku/Kizuna's logger.ts).
  KANSOKU_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  KANSOKU_INGEST_TOKEN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().optional(),
  ),

  // Google services (Gmail + Calendar) are vended via the Kao identity
  // service. Kokoro does not own a refresh token; it fetches short-lived
  // access tokens from Kao at https://api.kao.localhost/grants/kokoro/token.
  // `.url()` matches the sibling URL-shaped vars (KIOKU_URL, KIZUNA_URL) and
  // catches a typo'd value at startup instead of at first vend call.
  KAO_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  KAO_TOKEN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().optional(),
  ),

  TIMEZONE: z.string().default("America/New_York"),

  IMAGE_GENERATION_MODEL: z.string().optional(),

  TTS_PROVIDER: z.string().optional(),
  TTS_VOICE_ID: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),

  STT_PROVIDER: z.string().optional(),
  STT_BASE_URL: z.string().optional(),
  STT_API_KEY: z.string().optional(),

  BRAVE_SEARCH_API_KEY: z.string().optional(),

  BROWSER_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s === "true"),
  BROWSER_ENV: z.enum(["local", "cloud"]).default("local"),
  BROWSERBASE_API_KEY: z.string().optional(),
  BROWSERBASE_PROJECT_ID: z.string().optional(),
  BROWSER_MODEL: z.string().optional(),
  BROWSER_GEOLOCATION: z.string().optional(),
  BROWSER_DATA_DIR: z.string().default("./data/browser"),
  BROWSER_HEADLESS: z
    .string()
    .default("true")
    .transform((s) => s === "true"),

  LOCATION_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s === "true"),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  LOCATION_MOVEMENT_THRESHOLD_M: z.coerce.number().default(100),
  LOCATION_PROACTIVE_DELAY_MS: z.coerce.number().default(1_200_000),
  LOCATION_CONTEXT_MAX_AGE_H: z.coerce.number().default(12),
  PLACE_LEARNING_VISITS: z.coerce.number().int().positive().default(3),
  PLACE_LEARNING_RADIUS_M: z.coerce.number().positive().default(200),
  PLACE_LEARNING_WINDOW_DAYS: z.coerce.number().int().positive().default(30),

  BLUEBUBBLES_HOST: z.string().optional(),
  BLUEBUBBLES_PASSWORD: z.string().optional(),
  BLUEBUBBLES_WEBHOOK_PORT: z.coerce.number().default(4000),
  ALLOWED_IMESSAGE_HANDLES: z
    .string()
    .default("")
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean)
        : [],
    ),

  // External MCP servers (JSON array). Parsed/validated against mcpServerSchema.
  // Empty string / unset → no MCP tools. A malformed JSON string is left as-is
  // so the array schema below reports a clear "expected array" error rather than
  // silently dropping the value.
  MCP_SERVERS: z.preprocess((v) => {
    if (v === undefined) return [];
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    if (trimmed === "") return [];
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }, z.array(mcpServerSchema).default([])),

  CONTEXT_PATH: z.string().default("./context"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = baseSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

/**
 * Validates that required API keys are present based on configured providers.
 * Call this at app startup for apps that need LLM/embedding keys (e.g. the bot).
 * Apps that only need MONGODB_URI (e.g. the dashboard) can skip this.
 */
export function validateConfig(): void {
  const errors: string[] = [];

  const keyMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    xai: "XAI_API_KEY",
  };
  const requiredLLM = keyMap[config.LLM_PROVIDER];
  if (requiredLLM && !config[requiredLLM as keyof typeof config]) {
    errors.push(`${requiredLLM} is required when LLM_PROVIDER is "${config.LLM_PROVIDER}"`);
  }

  if (config.IMAGE_GENERATION_MODEL) {
    const slash = config.IMAGE_GENERATION_MODEL.indexOf("/");
    if (slash === -1) {
      errors.push(
        'IMAGE_GENERATION_MODEL must be in "provider/model" format (e.g., "xai/grok-imagine-image")',
      );
    } else {
      const provider = config.IMAGE_GENERATION_MODEL.slice(0, slash);
      const imageKeyMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        xai: "XAI_API_KEY",
        google: "GOOGLE_API_KEY",
      };
      const requiredKey = imageKeyMap[provider];
      if (requiredKey && !config[requiredKey as keyof typeof config]) {
        errors.push(
          `${requiredKey} is required when IMAGE_GENERATION_MODEL uses "${provider}" provider`,
        );
      }
    }
  }

  // Either both Kao vars or neither — half-configured means the gates that
  // activate the maid-service tool stack would fire while runtime calls
  // would 401 at Kao. Catch it at startup, not at the first Gmail call.
  const kaoFields = ["KAO_URL", "KAO_TOKEN"] as const;
  const setKao = kaoFields.filter((f) => config[f]);
  if (setKao.length > 0 && setKao.length < 2) {
    const missing = kaoFields.filter((f) => !config[f]);
    for (const field of missing) {
      errors.push(`${field} is required when any Kao variable is set`);
    }
  }

  if (config.TTS_PROVIDER) {
    const slash = config.TTS_PROVIDER.indexOf("/");
    if (slash === -1) {
      errors.push(
        'TTS_PROVIDER must be in "provider/model" format (e.g., "elevenlabs/eleven_flash_v2_5")',
      );
    } else {
      const provider = config.TTS_PROVIDER.slice(0, slash);
      const ttsKeyMap: Record<string, keyof typeof config | undefined> = {
        elevenlabs: "ELEVENLABS_API_KEY",
      };
      const requiredKey = ttsKeyMap[provider];
      if (requiredKey && !config[requiredKey]) {
        errors.push(`${requiredKey} is required when TTS_PROVIDER uses "${provider}" provider`);
      }
    }
    if (!config.TTS_VOICE_ID) {
      errors.push("TTS_VOICE_ID is required when TTS_PROVIDER is set");
    }
  }

  if (config.BROWSER_ENABLED && config.BROWSER_ENV === "cloud") {
    if (!config.BROWSERBASE_API_KEY) {
      errors.push('BROWSERBASE_API_KEY is required when BROWSER_ENV is "cloud"');
    }
    if (!config.BROWSERBASE_PROJECT_ID) {
      errors.push('BROWSERBASE_PROJECT_ID is required when BROWSER_ENV is "cloud"');
    }
  }

  if (config.LOCATION_ENABLED && !config.GOOGLE_MAPS_API_KEY) {
    errors.push("GOOGLE_MAPS_API_KEY is required when LOCATION_ENABLED is true");
  }

  // MCP server names become tool-name prefixes (mcp_<name>_<tool>) and must be
  // unique so two servers can't shadow each other's namespace.
  const mcpNames = config.MCP_SERVERS.map((s) => s.name);
  const dupeMcp = [...new Set(mcpNames.filter((n, i) => mcpNames.indexOf(n) !== i))];
  if (dupeMcp.length > 0) {
    errors.push(`MCP_SERVERS has duplicate server name(s): ${dupeMcp.join(", ")}`);
  }

  if (config.BLUEBUBBLES_HOST && !config.BLUEBUBBLES_PASSWORD) {
    errors.push("BLUEBUBBLES_PASSWORD is required when BLUEBUBBLES_HOST is set");
  }
  if (config.ALLOWED_IMESSAGE_HANDLES.length > 0 && !config.BLUEBUBBLES_HOST) {
    errors.push("BLUEBUBBLES_HOST is required when ALLOWED_IMESSAGE_HANDLES is non-empty");
  }

  if (config.STT_PROVIDER) {
    const slash = config.STT_PROVIDER.indexOf("/");
    if (slash === -1) {
      errors.push('STT_PROVIDER must be in "provider/model" format (e.g., "openai/whisper-1")');
    } else {
      const provider = config.STT_PROVIDER.slice(0, slash);
      // Cloud OpenAI and local whisper.cpp both use the OpenAI-compatible
      // /v1/audio/transcriptions endpoint, so the only "provider" surface
      // we recognise today is "openai". Local mode is just `STT_BASE_URL`
      // pointing at the local server.
      if (provider !== "openai") {
        errors.push(
          `STT_PROVIDER unknown provider "${provider}" — only "openai" is supported (use STT_BASE_URL for local servers)`,
        );
      }
      const hasKey = config.STT_API_KEY || config.OPENAI_API_KEY;
      if (!hasKey) {
        errors.push(
          "STT_API_KEY or OPENAI_API_KEY is required when STT_PROVIDER is set (use any non-empty placeholder for local whisper.cpp servers that don't enforce auth)",
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error("Config validation failed:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
}
