import { z } from "zod";
import { defineEnv, logging, type EnvOutput } from "@kagami/env";

/**
 * Kansoku API env spec — the single source of truth for this app's
 * configuration. `.env.example`, the docs/configuration.md table, and
 * turbo.json env declarations are all generated from it: edit here, then
 * `npm run env:gen`.
 *
 * This module must stay a leaf (zod + @kagami/env only) so the workspace
 * generator can import it without booting the app.
 *
 * Every key is defaulted or optional, and the tuning knobs carry
 * `onInvalid: "warn-default"`: Kansoku is deliberately fail-open — an
 * operator typo is never silently absorbed (it warns through the service
 * logger via config.ts), but it must never crash the observability service
 * either. The one hard-on-invalid key is MONGODB_URI: a data pointer must
 * never silently redirect to the localhost default database, so a malformed
 * value fails boot (matching the pre-migration MongoClient failure). Parsing
 * happens in config.ts (`loadEnv()`), which memoizes on the raw env values
 * so hot-path callers skip the re-parse and the re-warn.
 */

/**
 * Strict positive integer with a configurable floor. The regex rejects
 * anything other than a run of ASCII digits — `"30days"` (which `parseInt`
 * would silently accept as `30`), `"10x"`, `"+10"`, etc. all warn and fall
 * back to the default.
 */
const positiveInt = (def: number, min = 1) =>
  z
    .string()
    .regex(/^\d+$/, "must be a positive integer")
    .transform(Number)
    .pipe(z.number().int().min(min))
    .default(def);

const log = logging();

export const envSpec = defineEnv({
  service: "kansoku",
  component: "api",
  vars: {
    KANSOKU_HOST: z.string().default("127.0.0.1").meta({
      doc: "Standalone fallback bind host. Under `portless run`, PORT is injected\nautomatically and https://api.kansoku.localhost is proxied; these only\nmatter running standalone (e.g. `tsx src/server.ts`).",
      standaloneOnly: true,
      group: "Standalone fallback",
    }),
    PORT: z.coerce.number().int().positive().max(65_535).default(7779).meta({
      doc: "Standalone fallback bind port (Portless injects its own otherwise).\n7779 because Kioku owns 7777.",
      standaloneOnly: true,
      group: "Standalone fallback",
      onInvalid: "warn-default",
    }),

    ...log.vars,

    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must be a mongodb:// URI")
      .default("mongodb://127.0.0.1:27017/kansoku?directConnection=true")
      .meta({
        doc: 'Connection URI for the storage layer. Include the DB name in the path —\nmongo.ts reads it from there (and falls back to "kansoku" if the URI\'s\ndefault DB is "test"). Defaults to a local atlas-local replica set on\n127.0.0.1:27017. Boot it with:\n  atlas local start mongodb\n(or `docker run -p 27017:27017 mongodb/mongodb-atlas-local`).\nTime-series collections require MongoDB 5.0+.\nA malformed URI fails boot — only an UNSET value uses the local default\n(a data pointer must never silently redirect to a different database).',
        crossService: true,
        group: "MongoDB",
      }),

    KANSOKU_INGEST_TOKEN: z.string().optional().meta({
      doc: "Shared HMAC token presented by sibling shippers in the `x-kansoku-auth`\nheader. Generate one with `openssl rand -hex 32` and copy the same value\ninto each sibling service's KANSOKU_INGEST_TOKEN. Rotation is a manual\nenv-change-and-restart across the workspace.\n\nWhen unset, POST /v1/logs returns 503 fail-closed — the service won't\nsilently accept unauthenticated ingest.",
      secret: true,
      sharedAllowed: true,
      crossService: true,
      group: "Ingest auth",
    }),

    KANSOKU_LOGS_TTL_DAYS: positiveInt(30).meta({
      doc: 'Time-series TTL for the `logs` collection, in days. The server reconciles\nthis with `collMod` on every startup, so changing the value and restarting\ntakes effect without manual ops. Capped at 365 at apply time (longer\nretention degrades time-series bucket compaction). Strict integer parse —\n"30days" is rejected with a warn and the default kicks in.',
      onInvalid: "warn-default",
      group: "Retention",
    }),
    KANSOKU_ERRORS_TTL_DAYS: positiveInt(90).meta({
      doc: "TTL for the fingerprinted `errors` registry, in days (TTL index on\n`errors_last_seen`). A fingerprint that stops recurring ages out this many\ndays after its last hit; an active one keeps refreshing and never expires.\nSame collMod reconciliation, 365-day cap, and strict-integer parse as the\nlogs TTL.",
      onInvalid: "warn-default",
      group: "Retention",
    }),

    KANSOKU_MAX_META_COMBOS: positiveInt(1000).meta({
      doc: "Budget on distinct {service,component,env,level} metaField tuples tracked\nfor the time-series collection. Tuples under budget pass through; once it's\nexhausted, new tuples collapse into one sentinel bucket so bucket\ncardinality can't blow up. Strict integer parse; floor 1. Raise only if you\nlegitimately run that many service/component combos.",
      onInvalid: "warn-default",
      group: "Cardinality",
    }),

    KANSOKU_ALERT_WEBHOOK_URL: z.string().url().optional().meta({
      doc: 'Optional webhook fired when a brand-new error fingerprint shows up AND\nwhen an existing fingerprint spikes past KANSOKU_SPIKE_THRESHOLD within\nKANSOKU_SPIKE_WINDOW_MINUTES (subject to KANSOKU_SPIKE_COOLDOWN_MINUTES).\nSends a small JSON POST body — works with Discord/Slack-style webhooks\nor any custom endpoint. Fail-open: a webhook outage never wedges ingest,\nand an invalid URL warns and disables alerts instead of failing boot.\nPayload shapes:\n  { kind: "kansoku.error.new",   fingerprint, service, component, name?,\n    message, firstSeen, traceId? }\n  { kind: "kansoku.error.spike", fingerprint, service, component, name?,\n    message, count, windowMinutes, windowStart, lastSeen, traceId? }',
      // Discord/Slack webhook URLs embed a capability token in the path.
      secret: true,
      onInvalid: "warn-default",
      group: "Alerts",
    }),
    // `threshold=1` would make the spike alert unreachable: a fingerprint's
    // first sighting always takes the new-error path, and there is no second
    // sighting that hasn't already crossed the threshold. Floor at 2 so the
    // boundary is meaningful.
    KANSOKU_SPIKE_THRESHOLD: positiveInt(10, 2).meta({
      doc: "Spike fires when this many occurrences of the same fingerprint land\ninside the window. Strict positive integer; non-integer or <2 falls back\nto the default with a warn. Has no effect when KANSOKU_ALERT_WEBHOOK_URL\nis unset — evaluateSpike short-circuits before any Mongo write.",
      onInvalid: "warn-default",
      group: "Alerts",
    }),
    KANSOKU_SPIKE_WINDOW_MINUTES: positiveInt(5).meta({
      doc: "Rolling window for the spike counter, in minutes. Logs whose ts is older\nthan the window are skipped (replay guard) so a backfill doesn't trip the\nspike path even when arriving at wall-clock now. Strict positive integer.",
      onInvalid: "warn-default",
      group: "Alerts",
    }),
    KANSOKU_SPIKE_COOLDOWN_MINUTES: positiveInt(60).meta({
      doc: "Minimum gap between spike alerts for the same fingerprint. After firing,\nfurther threshold crossings are suppressed until this many minutes have\nelapsed. Strict positive integer.",
      onInvalid: "warn-default",
      group: "Alerts",
    }),
  },
});

export type Config = EnvOutput<typeof envSpec>;
