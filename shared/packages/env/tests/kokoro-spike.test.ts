/**
 * API-locking spike: re-expresses the ENTIRE Kokoro env surface
 * (kokoro/packages/shared/src/config.ts — 56 keys, module-scope exit-on-invalid
 * parse, plus all eight validateConfig() cross-field rule groups) through
 * defineEnv, and asserts behavioral fidelity.
 *
 * This file is deliberately decoupled from @kokoro/shared (importing it would
 * point the dependency arrow backwards). It is a faithful PORT, not an import.
 * Kokoro HAS migrated (kokoro/packages/shared/src/env.ts is the live spec and
 * kokoro's own config.test.ts covers the runtime contract); this spike stays
 * as the package-side regression lock for kokoro-shaped usage — the workspace's
 * hardest consumer surface (56 keys, transforms, preprocess, 8 cross groups).
 *
 * Two intentional behavior deltas vs. today's config.ts, both from the uniform
 * record-level emptyStringAsUndefined (which replaces the per-var preprocess
 * kokoro hand-applied to only SOME keys):
 *   1. A blank value on a defaulted var now falls back to the default
 *      (e.g. LLM_MODEL="" → "claude-sonnet-4-6"; previously stayed "").
 *   2. Kept values are trimmed (Kao already did this; Kokoro didn't).
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineEnv, kansokuShipper, kaoConsumer } from "../src/index.js";

const mcpServerNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/, "MCP server name must match [a-zA-Z0-9_-]");

const mcpServerSchema = z.union([
  z.object({
    name: mcpServerNameSchema,
    transport: z.enum(["http", "sse"]),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    name: mcpServerNameSchema,
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }),
]);

function buildKokoroSpec() {
  const kansoku = kansokuShipper();
  const kao = kaoConsumer();
  return defineEnv({
    service: "kokoro",
    component: "bot",
    requireDocs: false,
    vars: {
      TELEGRAM_BOT_TOKEN: z.string().optional(),
      ALLOWED_USER_IDS: z
        .string()
        .default("")
        .transform((s) => (s ? s.split(",").map(Number) : [])),

      LLM_KIND: z.enum(["native"]).default("native"),
      LLM_PROVIDER: z.enum(["anthropic", "openai", "xai"]).default("anthropic"),
      ANTHROPIC_API_KEY: z.string().optional(),
      OPENAI_API_KEY: z.string().optional(),
      LLM_MODEL: z.string().default("claude-sonnet-4-6"),
      LLM_MODEL_FAST: z.string().optional(),
      LLM_MODEL_SMART: z.string().optional(),
      LLM_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

      XAI_API_KEY: z.string().optional(),
      GOOGLE_API_KEY: z.string().optional(),

      MONGODB_URI: z.string().default("mongodb://localhost:27017/kokoro"),

      KIOKU_URL: z.string().url().default("https://api.kioku.localhost"),
      KIZUNA_URL: z.string().url().default("https://api.kizuna.localhost"),

      ...kansoku.vars,
      ...kao.vars,

      TIMEZONE: z.string().default("America/New_York"),

      IMAGE_GENERATION_MODEL: z.string().optional(),

      TTS_PROVIDER: z.string().optional(),
      TTS_VOICE_ID: z.string().optional(),
      ELEVENLABS_API_KEY: z.string().optional(),

      STT_PROVIDER: z.string().optional(),
      STT_BASE_URL: z.string().optional(),
      STT_API_KEY: z.string().optional(),

      BRAVE_SEARCH_API_KEY: z.string().optional(),

      BROWSER_ENV: z.enum(["local", "cloud"]).default("local"),
      BROWSERBASE_API_KEY: z.string().optional(),
      BROWSERBASE_PROJECT_ID: z.string().optional(),
      BROWSER_MODEL: z.string().optional(),
      BROWSER_GEOLOCATION: z.string().optional(),
      BROWSER_DATA_DIR: z.string().default("./data/browser"),
      BROWSER_HEADLESS: z
        .string()
        .default("true")
        .transform((s) => s === "true"),

      EXECUTE_CODE_ENABLED: z
        .string()
        .default("false")
        .transform((s) => s === "true"),
      EXECUTE_CODE_PYTHON_IMAGE: z.string().default("python:3.12-slim"),
      EXECUTE_CODE_NODE_IMAGE: z.string().default("node:22-slim"),
      EXECUTE_CODE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
      EXECUTE_CODE_MEMORY_MB: z.coerce.number().int().positive().default(512),

      GOOGLE_MAPS_API_KEY: z.string().optional(),
      LOCATION_MOVEMENT_THRESHOLD_M: z.coerce.number().default(100),
      LOCATION_PROACTIVE_DELAY_MS: z.coerce.number().default(1_200_000),
      LOCATION_CONTEXT_MAX_AGE_H: z.coerce.number().default(12),
      PLACE_LEARNING_VISITS: z.coerce.number().int().positive().default(3),
      PLACE_LEARNING_RADIUS_M: z.coerce.number().positive().default(200),
      PLACE_LEARNING_WINDOW_DAYS: z.coerce.number().int().positive().default(30),

      BLUEBUBBLES_HOST: z.string().optional(),
      BLUEBUBBLES_PASSWORD: z.string().optional(),
      BLUEBUBBLES_WEBHOOK_PORT: z.coerce.number().default(4000),
      ALLOWED_IMESSAGE_HANDLES: z
        .string()
        .default("")
        .transform((s) =>
          s
            ? s
                .split(",")
                .map((h) => h.trim())
                .filter(Boolean)
            : [],
        ),

      MCP_SERVERS: z.preprocess((v) => {
        if (v === undefined) return [];
        if (typeof v !== "string") return v;
        const trimmed = v.trim();
        if (trimmed === "") return [];
        try {
          return JSON.parse(trimmed) as unknown;
        } catch {
          return trimmed;
        }
      }, z.array(mcpServerSchema).default([])),

      ROUTINE_PROPOSAL_COOLDOWN_DAYS: z.coerce.number().int().positive().default(14),

      CONTEXT_PATH: z.string().default("./context"),

      LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
      NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    },
    cross: [
      // 1. LLM provider → key map
      (config) => {
        const keyMap = {
          anthropic: "ANTHROPIC_API_KEY",
          openai: "OPENAI_API_KEY",
          xai: "XAI_API_KEY",
        } as const;
        const required = keyMap[config.LLM_PROVIDER];
        return config[required]
          ? []
          : [`${required} is required when LLM_PROVIDER is "${config.LLM_PROVIDER}"`];
      },
      // 2. IMAGE_GENERATION_MODEL "provider/model" format + provider key
      (config) => {
        if (!config.IMAGE_GENERATION_MODEL) return [];
        const slash = config.IMAGE_GENERATION_MODEL.indexOf("/");
        if (slash === -1) {
          return ['IMAGE_GENERATION_MODEL must be in "provider/model" format'];
        }
        const provider = config.IMAGE_GENERATION_MODEL.slice(0, slash);
        const imageKeyMap: Record<string, keyof typeof config | undefined> = {
          anthropic: "ANTHROPIC_API_KEY",
          openai: "OPENAI_API_KEY",
          xai: "XAI_API_KEY",
          google: "GOOGLE_API_KEY",
        };
        const requiredKey = imageKeyMap[provider];
        return requiredKey && !config[requiredKey]
          ? [`${requiredKey} is required when IMAGE_GENERATION_MODEL uses "${provider}" provider`]
          : [];
      },
      // 3. Kao both-or-neither (shared block)
      ...kao.cross,
      // 4. TTS provider/model + key + voice id
      (config) => {
        if (!config.TTS_PROVIDER) return [];
        const issues: string[] = [];
        const slash = config.TTS_PROVIDER.indexOf("/");
        if (slash === -1) {
          issues.push('TTS_PROVIDER must be in "provider/model" format');
        } else if (
          config.TTS_PROVIDER.slice(0, slash) === "elevenlabs" &&
          !config.ELEVENLABS_API_KEY
        ) {
          issues.push(
            'ELEVENLABS_API_KEY is required when TTS_PROVIDER uses "elevenlabs" provider',
          );
        }
        if (!config.TTS_VOICE_ID) issues.push("TTS_VOICE_ID is required when TTS_PROVIDER is set");
        return issues;
      },
      // 5. Browser cloud mode needs Browserbase credentials
      (config) => {
        if (config.BROWSER_ENV !== "cloud") return [];
        const issues: string[] = [];
        if (!config.BROWSERBASE_API_KEY)
          issues.push('BROWSERBASE_API_KEY is required when BROWSER_ENV is "cloud"');
        if (!config.BROWSERBASE_PROJECT_ID)
          issues.push('BROWSERBASE_PROJECT_ID is required when BROWSER_ENV is "cloud"');
        return issues;
      },
      // 6. MCP server names must be unique (they become tool-name prefixes)
      (config) => {
        const names = config.MCP_SERVERS.map((s) => s.name);
        const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
        return dupes.length > 0
          ? [`MCP_SERVERS has duplicate server name(s): ${dupes.join(", ")}`]
          : [];
      },
      // 7. BlueBubbles pairings
      (config) => {
        const issues: string[] = [];
        if (config.BLUEBUBBLES_HOST && !config.BLUEBUBBLES_PASSWORD) {
          issues.push("BLUEBUBBLES_PASSWORD is required when BLUEBUBBLES_HOST is set");
        }
        if (config.ALLOWED_IMESSAGE_HANDLES.length > 0 && !config.BLUEBUBBLES_HOST) {
          issues.push("BLUEBUBBLES_HOST is required when ALLOWED_IMESSAGE_HANDLES is non-empty");
        }
        return issues;
      },
      // 8. STT provider format, openai-only, key fallback
      (config) => {
        if (!config.STT_PROVIDER) return [];
        const slash = config.STT_PROVIDER.indexOf("/");
        if (slash === -1) return ['STT_PROVIDER must be in "provider/model" format'];
        const issues: string[] = [];
        if (config.STT_PROVIDER.slice(0, slash) !== "openai") {
          issues.push(`STT_PROVIDER unknown provider — only "openai" is supported`);
        }
        if (!config.STT_API_KEY && !config.OPENAI_API_KEY) {
          issues.push("STT_API_KEY or OPENAI_API_KEY is required when STT_PROVIDER is set");
        }
        return issues;
      },
    ],
  });
}

// Minimal env satisfying cross-check 1 (the only one that fires on {}).
const base = { ANTHROPIC_API_KEY: "key" };

describe("kokoro spike: full 56-key schema fidelity", () => {
  const spec = buildKokoroSpec();

  it("declares all 56 keys", () => {
    expect(spec.keyNames).toHaveLength(56);
  });

  it("parses an empty env to kokoro's defaults (dashboard path: cross skipped)", () => {
    const config = spec.parse({}, { cross: "skip" });
    expect(config.LLM_PROVIDER).toBe("anthropic");
    expect(config.LLM_MODEL).toBe("claude-sonnet-4-6");
    expect(config.LLM_ATTEMPT_TIMEOUT_MS).toBe(30_000);
    expect(config.MONGODB_URI).toBe("mongodb://localhost:27017/kokoro");
    expect(config.KIOKU_URL).toBe("https://api.kioku.localhost");
    expect(config.KIZUNA_URL).toBe("https://api.kizuna.localhost");
    expect(config.TIMEZONE).toBe("America/New_York");
    expect(config.BROWSER_ENV).toBe("local");
    expect(config.BROWSER_HEADLESS).toBe(true);
    expect(config.EXECUTE_CODE_ENABLED).toBe(false);
    expect(config.EXECUTE_CODE_PYTHON_IMAGE).toBe("python:3.12-slim");
    expect(config.EXECUTE_CODE_TIMEOUT_MS).toBe(120_000);
    expect(config.EXECUTE_CODE_MEMORY_MB).toBe(512);
    expect(config.ALLOWED_USER_IDS).toEqual([]);
    expect(config.ALLOWED_IMESSAGE_HANDLES).toEqual([]);
    expect(config.MCP_SERVERS).toEqual([]);
    expect(config.ROUTINE_PROPOSAL_COOLDOWN_DAYS).toBe(14);
    expect(config.BLUEBUBBLES_WEBHOOK_PORT).toBe(4000);
    expect(config.PLACE_LEARNING_VISITS).toBe(3);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.NODE_ENV).toBe("development");
  });

  it("bot path: cross-checks fire on {} (anthropic provider without a key)", () => {
    expect(() => spec.parse({})).toThrow(/ANTHROPIC_API_KEY is required/);
    expect(spec.parse(base).ANTHROPIC_API_KEY).toBe("key");
  });

  it("transforms comma lists: ALLOWED_USER_IDS and ALLOWED_IMESSAGE_HANDLES", () => {
    const config = spec.parse({
      ...base,
      ALLOWED_USER_IDS: "123,456",
      ALLOWED_IMESSAGE_HANDLES: " +15551234567 , user@example.com ,,",
      BLUEBUBBLES_HOST: "http://localhost:1234",
      BLUEBUBBLES_PASSWORD: "pw",
    });
    expect(config.ALLOWED_USER_IDS).toEqual([123, 456]);
    expect(config.ALLOWED_IMESSAGE_HANDLES).toEqual(["+15551234567", "user@example.com"]);
  });

  it("blank numeric knobs fall back to defaults (the hand-rolled preprocess, now uniform)", () => {
    const config = spec.parse({
      ...base,
      LLM_ATTEMPT_TIMEOUT_MS: "",
      EXECUTE_CODE_MEMORY_MB: "  ",
    });
    expect(config.LLM_ATTEMPT_TIMEOUT_MS).toBe(30_000);
    expect(config.EXECUTE_CODE_MEMORY_MB).toBe(512);
  });

  it("INTENTIONAL DELTA: blank on a defaulted string var now falls back to the default", () => {
    // Today's kokoro config keeps LLM_MODEL="" as the empty string (only some
    // vars got the blank preprocess). Uniform blanking makes "" mean unset.
    expect(spec.parse({ ...base, LLM_MODEL: "" }).LLM_MODEL).toBe("claude-sonnet-4-6");
  });

  it("EXECUTE_CODE_ENABLED is literal-'true' only", () => {
    expect(spec.parse({ ...base, EXECUTE_CODE_ENABLED: "true" }).EXECUTE_CODE_ENABLED).toBe(true);
    expect(spec.parse({ ...base, EXECUTE_CODE_ENABLED: "false" }).EXECUTE_CODE_ENABLED).toBe(false);
    expect(spec.parse({ ...base, EXECUTE_CODE_ENABLED: "TRUE" }).EXECUTE_CODE_ENABLED).toBe(false);
    expect(spec.parse({ ...base, EXECUTE_CODE_ENABLED: "" }).EXECUTE_CODE_ENABLED).toBe(false);
  });

  it("MCP_SERVERS: parses http and stdio entries, rejects malformed JSON loudly", () => {
    const servers = JSON.stringify([
      { name: "files", transport: "stdio", command: "mcp-files" },
      { name: "search", transport: "http", url: "https://mcp.example.com" },
    ]);
    const config = spec.parse({ ...base, MCP_SERVERS: servers });
    expect(config.MCP_SERVERS).toHaveLength(2);
    expect(() => spec.parse({ ...base, MCP_SERVERS: "not json" })).toThrow(/MCP_SERVERS/);
    expect(() =>
      spec.parse({
        ...base,
        MCP_SERVERS: JSON.stringify([{ name: "bad name!", transport: "stdio", command: "x" }]),
      }),
    ).toThrow(/MCP_SERVERS/);
  });

  it("cross 1: provider→key map for openai and xai", () => {
    expect(() => spec.parse({ LLM_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY is required/);
    expect(() => spec.parse({ LLM_PROVIDER: "xai" })).toThrow(/XAI_API_KEY is required/);
    expect(spec.parse({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" }).LLM_PROVIDER).toBe("openai");
  });

  it("cross 2: IMAGE_GENERATION_MODEL format and provider key", () => {
    expect(() => spec.parse({ ...base, IMAGE_GENERATION_MODEL: "no-slash" })).toThrow(
      /provider\/model/,
    );
    expect(() => spec.parse({ ...base, IMAGE_GENERATION_MODEL: "google/imagen" })).toThrow(
      /GOOGLE_API_KEY/,
    );
    expect(
      spec.parse({ ...base, IMAGE_GENERATION_MODEL: "google/imagen", GOOGLE_API_KEY: "g" })
        .IMAGE_GENERATION_MODEL,
    ).toBe("google/imagen");
  });

  it("cross 3: Kao pair is both-or-neither", () => {
    expect(() => spec.parse({ ...base, KAO_URL: "https://api.kao.localhost" })).toThrow(
      /KAO_TOKEN is required/,
    );
  });

  it("cross 4: TTS rules", () => {
    expect(() => spec.parse({ ...base, TTS_PROVIDER: "elevenlabs" })).toThrow(/provider\/model/);
    expect(() => spec.parse({ ...base, TTS_PROVIDER: "elevenlabs/eleven_flash_v2_5" })).toThrow(
      /ELEVENLABS_API_KEY.*\n.*TTS_VOICE_ID/,
    );
    const ok = spec.parse({
      ...base,
      TTS_PROVIDER: "elevenlabs/eleven_flash_v2_5",
      ELEVENLABS_API_KEY: "k",
      TTS_VOICE_ID: "v",
    });
    expect(ok.TTS_VOICE_ID).toBe("v");
  });

  it("cross 5: cloud browser needs Browserbase creds", () => {
    expect(() => spec.parse({ ...base, BROWSER_ENV: "cloud" })).toThrow(
      /BROWSERBASE_API_KEY.*\n.*BROWSERBASE_PROJECT_ID/,
    );
  });

  it("cross 6: duplicate MCP server names rejected", () => {
    const dupes = JSON.stringify([
      { name: "tools", transport: "stdio", command: "a" },
      { name: "tools", transport: "stdio", command: "b" },
    ]);
    expect(() => spec.parse({ ...base, MCP_SERVERS: dupes })).toThrow(/duplicate server name/);
  });

  it("cross 7: BlueBubbles pairings", () => {
    expect(() => spec.parse({ ...base, BLUEBUBBLES_HOST: "http://h" })).toThrow(
      /BLUEBUBBLES_PASSWORD is required/,
    );
    expect(() => spec.parse({ ...base, ALLOWED_IMESSAGE_HANDLES: "+1555" })).toThrow(
      /BLUEBUBBLES_HOST is required/,
    );
  });

  it("cross 8: STT rules", () => {
    expect(() => spec.parse({ ...base, STT_PROVIDER: "whisper" })).toThrow(/provider\/model/);
    expect(() => spec.parse({ ...base, STT_PROVIDER: "local/whisper" })).toThrow(
      /only "openai" is supported/,
    );
    // OPENAI_API_KEY satisfies the key fallback even when STT_API_KEY is unset.
    const ok = spec.parse({ ...base, STT_PROVIDER: "openai/whisper-1", OPENAI_API_KEY: "k" });
    expect(ok.STT_PROVIDER).toBe("openai/whisper-1");
  });

  it("supports kokoro's module-scope exit contract", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => spec.parse({ KIOKU_URL: "not-a-url" }, { onInvalid: "exit" })).toThrow("exited");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("KIOKU_URL"));
    vi.restoreAllMocks();
  });
});
