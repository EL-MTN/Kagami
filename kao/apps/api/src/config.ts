import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

const blankAsUndefined = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const base64Key32 = z.preprocess(
  blankAsUndefined,
  z.string().refine((s) => {
    try {
      return Buffer.from(s, "base64").length === 32;
    } catch {
      return false;
    }
  }, "must be a base64-encoded 32-byte key"),
);

// Both public-facing URLs are rendered into anchor hrefs in the inline
// operator pages and composed with path suffixes (`${KAO_DASHBOARD_URL}/grants/:n`).
// Reject non-http(s) schemes (no `javascript:`) AND non-origin URLs (no path,
// query, or fragment) so composition can't produce a malformed href like
// `https://kao.localhost/foo?bar/grants/kokoro`. `new URL` always yields
// pathname '/' for an origin-only http(s) URL, so we only check against '/'.
const httpOrigin = z
  .string()
  .url()
  .refine((u) => {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      if (parsed.search !== "" || parsed.hash !== "") return false;
      if (parsed.pathname !== "/") return false;
      return true;
    } catch {
      return false;
    }
  }, "must be an http(s) origin with no path/query/fragment");

const envSchema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must be a mongodb:// URI"),
  KAO_DB_NAME: z.preprocess(blankAsUndefined, z.string().min(1).default("kao")),

  // Kao's whole purpose is OAuth — these are required, not optional.
  GOOGLE_OAUTH_CLIENT_ID: z.preprocess(blankAsUndefined, z.string().min(1)),
  GOOGLE_OAUTH_CLIENT_SECRET: z.preprocess(blankAsUndefined, z.string().min(1)),

  // Public origin Google redirects back to. The callback path is fixed; the
  // grant is carried in signed state, so only one redirect URI is registered.
  KAO_PUBLIC_URL: z.preprocess(blankAsUndefined, httpOrigin.default("https://api.kao.localhost")),

  // Where operators land after consent succeeds. Distinct from KAO_PUBLIC_URL
  // because the dashboard runs on a separate Portless name (kao.localhost vs
  // api.kao.localhost). The OAuth success page links here so the consent
  // round-trip ends back on the dashboard, not on the API's inline-HTML home.
  KAO_DASHBOARD_URL: z.preprocess(blankAsUndefined, httpOrigin.default("https://kao.localhost")),

  KAO_ENCRYPTION_KEY: base64Key32,

  // The bearer sibling services present to reach /grants/* (the vend surface).
  // Minimum length keeps a fat-fingered short token from being accepted.
  KAO_TOKEN: z.preprocess(
    blankAsUndefined,
    z.string().min(16, "KAO_TOKEN must be at least 16 chars"),
  ),

  KAO_HOST: z.preprocess(blankAsUndefined, z.string().default("127.0.0.1")),
  PORT: z.coerce.number().int().positive().max(65_535).default(4040),
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

export function callbackUrl(config: Config): string {
  return `${config.KAO_PUBLIC_URL.replace(/\/+$/, "")}/oauth/callback`;
}
