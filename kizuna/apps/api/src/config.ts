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
    KAO_URL: z.preprocess(
      blankAsUndefined,
      z
        .string()
        .url()
        // Host-only URL. A KAO_URL that smuggles in a path/query/fragment
        // (e.g. a copy-paste from a curl command with `?debug=1` still
        // appended) would interpolate into malformed downstream URLs like
        // `https://api.kao.localhost?debug=1/grants/kizuna/token`. Caught
        // at startup with a clear message instead of as an opaque Kao 404
        // at first ingest.
        //
        // Also reject embedded userinfo (`https://user:secret@host`). The
        // explicit `Authorization: Bearer` header overrides anything in
        // userinfo so it's functionally dead at the wire — but `${base}`
        // gets interpolated into KaoNoGrantError messages that flow into
        // SyncState.lastError, structured logs, and Kansoku. Leaving the
        // credentials in there would leak them.
        //
        // The try/catch is REQUIRED even though `.url()` runs first in the
        // chain: zod's check pipeline does NOT short-circuit between
        // siblings, so an upstream `.url()` failure still invokes this
        // refine on the invalid string and `new URL(s)` throws a raw
        // TypeError that escapes `safeParse`. The catch keeps loadConfig's
        // formatted-issue contract intact.
        .refine((s) => {
          try {
            const u = new URL(s);
            return (
              (u.pathname === "" || u.pathname === "/") &&
              u.search === "" &&
              u.hash === "" &&
              u.username === "" &&
              u.password === ""
            );
          } catch {
            return false;
          }
        }, "KAO_URL must be host-only (no path, query, fragment, or userinfo)")
        .optional(),
    ),
    // Kao's own config enforces `min(16)` on the same bearer; mirror it here
    // so a truncated/typo'd token fails at boot instead of as a runtime 401.
    KAO_TOKEN: z.preprocess(
      blankAsUndefined,
      z.string().min(16, "KAO_TOKEN must be at least 16 characters").optional(),
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
