import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_USER_IDS: z
    .string()
    .default("")
    .transform((s) => (s ? s.split(",").map(Number) : [])),

  LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-sonnet-4-5"),

  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required for image generation"),

  MONGODB_URI: z.string().default("mongodb://localhost:27017/aigf"),

  VAULT_PATH: z.string().default("./vault"),
  CONTEXT_PATH: z.string().default("./context"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
