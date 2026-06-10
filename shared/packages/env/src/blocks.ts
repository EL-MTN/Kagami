import { z } from "zod";

/**
 * Composable shared blocks. Each factory returns `{ vars, cross? }`; callers
 * spread them into their own spec:
 *
 *   const kansoku = kansokuShipper();
 *   defineEnv({ vars: { ...kansoku.vars, MY_VAR: ... }, cross: [...] })
 *
 * Keeping composition as a plain spread (instead of a `blocks:` option) keeps
 * the output type fully inferred with zero generics machinery.
 */

/**
 * Kansoku observability shipper pair. Deliberately NO hard cross-check: a
 * half-set pair leaves the logger stdout-only (fail-open by design across the
 * workspace) — observability config must never make boot fail. For the same
 * reason KANSOKU_URL is warn-default, not a hard `.url()` error: a typo'd URL
 * warns and drops the key to undefined (shipper disabled) instead of wedging
 * the producer's boot. The doctor surfaces half-set pairs as a warning.
 */
export function kansokuShipper() {
  return {
    vars: {
      KANSOKU_URL: z.string().url().optional().meta({
        doc: "Ship every log line to the workspace's Kansoku service alongside stdout.\nBoth Kansoku vars must be set together — either missing leaves the logger\nstdout-only (fail-open; observability failure never wedges this service).\nAn invalid URL likewise warns and disables the shipper instead of failing\nboot.",
        example: "https://api.kansoku.localhost",
        sharedAllowed: true,
        crossService: true,
        onInvalid: "warn-default",
        group: "Kansoku (observability)",
      }),
      KANSOKU_INGEST_TOKEN: z.string().optional().meta({
        doc: "Shared HMAC token the Kansoku ingest surface requires.",
        secret: true,
        sharedAllowed: true,
        crossService: true,
        group: "Kansoku (observability)",
      }),
    },
  };
}

/**
 * Kao identity-consumer pair, for services that fetch short-lived Google
 * access tokens from Kao (Kokoro, Kizuna). Hard both-or-neither: a half-set
 * pair would activate the Google tool stack while every vend call 401s.
 * The min(16) mirrors Kao's own bearer floor (Kizuna already enforced it;
 * Kokoro historically didn't — adopting the block closes that drift).
 */
export function kaoConsumer() {
  const vars = {
    KAO_URL: z
      .string()
      .url()
      // Host-only URL. A path/query/fragment that smuggles in (e.g. `?debug=1`
      // left over from a curl paste) would interpolate into malformed vend
      // URLs like `https://api.kao.localhost?debug=1/grants/<consumer>/token`,
      // and embedded userinfo (`https://user:secret@host`) is functionally
      // dead at the wire (the Bearer header wins) but `${base}` flows into
      // error messages, structured logs, and Kansoku — leaving credentials
      // there would leak them. The try/catch is REQUIRED even though `.url()`
      // runs first in the chain: zod's check pipeline does NOT short-circuit
      // between siblings, so this refine still runs on the invalid string and
      // a bare `new URL(s)` throw would escape `safeParse`.
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
      .optional()
      .meta({
        doc: "Kao identity service origin; short-lived Google access tokens are vended\nfrom ${KAO_URL}/grants/<consumer>/token. Set together with KAO_TOKEN.",
        example: "https://api.kao.localhost",
        sharedAllowed: true,
        crossService: true,
        group: "Kao (Google identity)",
      }),
    KAO_TOKEN: z.string().min(16, "KAO_TOKEN must be at least 16 chars").optional().meta({
      doc: "Bearer presented to Kao's /grants/* vend surface (≥16 chars).",
      secret: true,
      sharedAllowed: true,
      crossService: true,
      group: "Kao (Google identity)",
    }),
  };
  const cross = [
    (config: { KAO_URL?: string | undefined; KAO_TOKEN?: string | undefined }): string[] => {
      const set = [config.KAO_URL, config.KAO_TOKEN].filter((v) => v !== undefined).length;
      if (set === 1) {
        return [
          config.KAO_URL === undefined
            ? "KAO_URL is required when any Kao variable is set"
            : "KAO_TOKEN is required when any Kao variable is set",
        ];
      }
      return [];
    },
  ];
  return { vars, cross };
}

/** MongoDB connection string. Pass a default for services that boot fine on a local instance; omit it where Mongo is non-negotiable (Kao). */
export function mongo(options: { defaultUri?: string; doc?: string } = {}) {
  const schema = z.string().regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must be a mongodb:// URI");
  const composed = options.defaultUri ? schema.default(options.defaultUri) : schema;
  return {
    vars: {
      MONGODB_URI: composed.meta({
        doc: options.doc ?? "MongoDB connection string (`mongodb://` or `mongodb+srv://`).",
        ...(options.defaultUri ? {} : { example: "mongodb://127.0.0.1:27017/<db>" }),
        crossService: true,
      }),
    },
  };
}

/** Pino level knob consumed by each service's @kagami/logger wrapper. */
export function logging() {
  return {
    vars: {
      LOG_LEVEL: z
        .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
        .default("info")
        .meta({
          doc: "Pino log level (`silent` in tests).",
          group: "Logging",
        }),
    },
  };
}
