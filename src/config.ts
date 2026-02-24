import "dotenv/config";
import { z } from "zod";

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    ALLOWED_USER_IDS: z
      .string()
      .default("")
      .transform((s) => (s ? s.split(",").map(Number) : [])),

    LLM_PROVIDER: z.enum(["anthropic", "openai", "xai"]).default("anthropic"),
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().default("claude-sonnet-4-5"),

    XAI_API_KEY: z.string().optional(),

    GOOGLE_API_KEY: z.string().optional(),
    EMBEDDING_PROVIDER: z.enum(["google"]).default("google"),
    EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),

    MONGODB_URI: z.string().default("mongodb://localhost:27017/aigf"),

    VAULT_PATH: z.string().default("./vault"),
    CONTEXT_PATH: z.string().default("./context"),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .superRefine((data, ctx) => {
    const keyMap: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      xai: "XAI_API_KEY",
    };
    const required = keyMap[data.LLM_PROVIDER];
    if (required && !data[required as keyof typeof data]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${required} is required when LLM_PROVIDER is "${data.LLM_PROVIDER}"`,
        path: [required],
      });
    }

    const embeddingKeyMap: Record<string, string> = {
      google: "GOOGLE_API_KEY",
    };
    const requiredEmbedding = embeddingKeyMap[data.EMBEDDING_PROVIDER];
    if (requiredEmbedding && !data[requiredEmbedding as keyof typeof data]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${requiredEmbedding} is required when EMBEDDING_PROVIDER is "${data.EMBEDDING_PROVIDER}"`,
        path: [requiredEmbedding],
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
