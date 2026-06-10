import { z } from "zod";
import { defineEnv, kansokuShipper, kaoConsumer, logging, type EnvOutput } from "@kagami/env";

/**
 * Kizuna API env spec — the single source of truth for this app's
 * configuration. `.env.example`, the docs/configuration.md table, and
 * turbo.json env declarations are all generated from it: edit here, then
 * `npm run env:gen`.
 *
 * This module must stay a leaf (zod + @kagami/env only) so the workspace
 * generator can import it without booting the app.
 */

const csv = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const kao = kaoConsumer();
const kansoku = kansokuShipper();
const log = logging();

export const envSpec = defineEnv({
  service: "kizuna",
  component: "api",
  vars: {
    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must be a mongodb:// URI")
      .meta({
        doc: "MongoDB connection (`mongodb://` or `mongodb+srv://`).",
        example: "mongodb://127.0.0.1:27017/kizuna",
        crossService: true,
      }),
    USER_EMAILS: z
      .string()
      .min(1, "USER_EMAILS must list at least one address")
      .transform((s) => csv(s).map((e) => e.toLowerCase()))
      .pipe(z.array(z.string().email()).min(1))
      .meta({
        doc: 'Comma-separated list of the operator\'s own email addresses (lowercased,\neach validated). The ingest workers use it for "self" detection — which\nside of an email or event is me. It is not an authentication boundary.',
        example: "you@example.com",
        sharedAllowed: true,
        crossService: true,
      }),

    // Google access (Gmail + Calendar, read-only) is vended by the Kao
    // identity service — Kizuna no longer owns a refresh token. The 'kizuna'
    // grant in Kao's registry is consented for gmail.readonly +
    // calendar.readonly; consent is granted at ${KAO_URL}/oauth/kizuna/start.
    ...kao.vars,

    KIZUNA_DASHBOARD_ORIGIN: z
      .string()
      .optional()
      .transform((s) => (s ? csv(s) : []))
      .meta({
        doc: "Extra browser Origin values allowed to POST /oauth/google/start (CSRF\nallowlist), comma-separated. https://kizuna.localhost is always allowed;\nset this only when the dashboard runs on a different origin (renamed\nPortless host, bare-port debug, SSH tunnel, staging deploy).",
        example: "",
      }),
    NEWSLETTER_DOMAIN_BLOCKLIST: z
      .string()
      .optional()
      .transform((s) => (s ? csv(s).map((d) => d.toLowerCase()) : []))
      .meta({
        doc: "Comma-separated sender domains to skip during Gmail ingest (newsletter\nnoise), lowercased.",
        example: "",
      }),
    KIZUNA_GMAIL_BACKFILL_DAYS: z.coerce.number().int().min(1).max(365).default(30).meta({
      doc: "Initial Gmail backfill horizon in days (1–365). Applies only on the\nworker's first (bootstrap) run; incremental runs use cursors.",
    }),
    KIZUNA_GCAL_BACKFILL_DAYS: z.coerce.number().int().min(1).max(365).default(60).meta({
      doc: "Initial Calendar backfill horizon in days (1–365). Applies only on the\nworker's first (bootstrap) run; incremental runs use cursors.",
    }),
    KIZUNA_INGEST_INTERVAL_SEC: z.coerce.number().int().min(0).max(86_400).default(0).meta({
      doc: "Ingest scheduler period in seconds (0–86400). 0 disables the in-process\nscheduler entirely — manual triggers via POST /sync/{gmail,gcal}/run still\nwork. Set to 300 (5 min) for typical dev use.",
    }),

    KIZUNA_HOST: z.string().default("127.0.0.1").meta({
      doc: "Standalone fallback bind host. Portless injects PORT and proxies\nhttps://api.kizuna.localhost; these only matter running outside Portless.",
      standaloneOnly: true,
      group: "Standalone fallback",
    }),
    PORT: z.coerce.number().int().positive().max(65_535).default(3000).meta({
      doc: "Standalone fallback bind port (Portless injects its own otherwise).",
      standaloneOnly: true,
      group: "Standalone fallback",
    }),

    ...log.vars,
    ...kansoku.vars,
  },
  // Either both Kao vars or neither — half-configured means /oauth and /sync
  // would try to call Kao and fail at request time. Catch it at startup.
  cross: [...kao.cross],
});

export type Config = EnvOutput<typeof envSpec>;
