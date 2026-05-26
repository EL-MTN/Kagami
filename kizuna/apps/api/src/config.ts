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

const envSchema = z
  .object({
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must be a mongodb:// URI"),
    USER_EMAILS: z
      .string()
      .min(1, "USER_EMAILS must list at least one address")
      .transform((s) => csv(s).map((e) => e.toLowerCase()))
      .pipe(z.array(z.string().email()).min(1)),
    // Google access is vended by the Kao identity service — Kizuna no longer
    // owns a refresh token. Set both vars together; consent is granted at
    // ${KAO_URL}/oauth/kizuna/start. The 'kizuna' grant in Kao's registry is
    // consented for gmail.readonly + calendar.readonly.
    KAO_URL: optionalUrl,
    KAO_TOKEN: optionalString,
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
  })
  // Either both Kao vars or neither — half-configured means /oauth and /sync
  // would try to call Kao and fail at request time. Catch it at startup.
  .refine((c) => Boolean(c.KAO_URL) === Boolean(c.KAO_TOKEN), {
    message: "KAO_URL and KAO_TOKEN must be set together",
    path: ["KAO_TOKEN"],
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
