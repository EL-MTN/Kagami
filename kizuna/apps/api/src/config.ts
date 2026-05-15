import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

const csv = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const blankAsUndefined = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const optionalString = z.preprocess(blankAsUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(blankAsUndefined, z.string().url().optional());

const envSchema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must be a mongodb:// URI"),
  USER_EMAILS: z
    .string()
    .min(1, "USER_EMAILS must list at least one address")
    .transform((s) => csv(s).map((e) => e.toLowerCase()))
    .pipe(z.array(z.string().email()).min(1)),
  GOOGLE_OAUTH_CLIENT_ID: optionalString,
  GOOGLE_OAUTH_CLIENT_SECRET: optionalString,
  GOOGLE_OAUTH_REDIRECT_URI: optionalUrl,
  KIZUNA_OAUTH_ENCRYPTION_KEY: z.preprocess(
    blankAsUndefined,
    z
      .string()
      .refine((s) => {
        try {
          return Buffer.from(s, "base64").length === 32;
        } catch {
          return false;
        }
      }, "must be a base64-encoded 32-byte key")
      .optional(),
  ),
  NEWSLETTER_DOMAIN_BLOCKLIST: z
    .string()
    .optional()
    .transform((s) => (s ? csv(s).map((d) => d.toLowerCase()) : [])),
  KIZUNA_GMAIL_BACKFILL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  KIZUNA_GCAL_BACKFILL_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  // 0 disables the in-process scheduler. Manual triggers via
  // POST /sync/{gmail,gcal}/run still work.
  KIZUNA_INGEST_INTERVAL_SEC: z.coerce.number().int().min(0).max(86_400).default(0),
  KIZUNA_HOST: z.preprocess(blankAsUndefined, z.string().default("127.0.0.1")),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  const source = env ?? process.env;
  if (!env) dotenvConfig();
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
