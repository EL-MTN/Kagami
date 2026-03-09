import "dotenv/config";
import { z } from "zod";

const baseSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  ALLOWED_USER_IDS: z
    .string()
    .default("")
    .transform((s) => (s ? s.split(",").map(Number) : [])),

  LLM_PROVIDER: z.enum(["anthropic", "openai", "xai"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-sonnet-4-6"),

  XAI_API_KEY: z.string().optional(),

  GOOGLE_API_KEY: z.string().optional(),
  EMBEDDING_PROVIDER: z.enum(["google"]).default("google"),
  EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),

  MONGODB_URI: z.string().default("mongodb://localhost:27017/mashiro"),

  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional(),

  TIMEZONE: z.string().default("America/New_York"),

  BROWSER_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s === "true"),
  BROWSER_MODEL: z.string().optional(),
  BROWSER_DATA_DIR: z.string().default("./data/browser"),
  BROWSER_HEADLESS: z
    .string()
    .default("true")
    .transform((s) => s === "true"),

  VAULT_PATH: z.string().default("./vault"),
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

  const embeddingKeyMap: Record<string, string> = {
    google: "GOOGLE_API_KEY",
  };
  const requiredEmbedding = embeddingKeyMap[config.EMBEDDING_PROVIDER];
  if (requiredEmbedding && !config[requiredEmbedding as keyof typeof config]) {
    errors.push(
      `${requiredEmbedding} is required when EMBEDDING_PROVIDER is "${config.EMBEDDING_PROVIDER}"`,
    );
  }

  const googleOAuthFields = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
  ] as const;
  const setFields = googleOAuthFields.filter((f) => config[f]);
  if (setFields.length > 0 && setFields.length < 3) {
    const missing = googleOAuthFields.filter((f) => !config[f]);
    for (const field of missing) {
      errors.push(`${field} is required when any Google OAuth variable is set`);
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
