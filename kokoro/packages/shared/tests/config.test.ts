import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `config.ts` parses `process.env` at module load and exposes `validateConfig`,
 * which logs to console.error and calls `process.exit(1)` on misconfig. To test
 * different env scenarios in isolation we:
 *
 *   1. `vi.stubEnv` the variables under test (and clear anything from .env that
 *      would leak in)
 *   2. `vi.resetModules()` so `config.ts` re-parses
 *   3. Mock `process.exit` to throw — that's our "validation failed" signal
 *   4. Capture console.error to assert on the specific messages
 */

// All env keys consumed by config.ts that influence validateConfig branches.
// We clear every one of these in beforeEach so each test starts from a known
// blank slate, then each test sets the handful it needs.
const RELEVANT_ENV_KEYS = [
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "IMAGE_GENERATION_MODEL",
  "TTS_PROVIDER",
  "TTS_VOICE_ID",
  "ELEVENLABS_API_KEY",
  "STT_PROVIDER",
  "STT_BASE_URL",
  "STT_API_KEY",
  "BROWSER_ENABLED",
  "BROWSER_ENV",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "LOCATION_ENABLED",
  "GOOGLE_MAPS_API_KEY",
  "PLACE_LEARNING_VISITS",
  "PLACE_LEARNING_RADIUS_M",
  "PLACE_LEARNING_WINDOW_DAYS",
  "BLUEBUBBLES_HOST",
  "BLUEBUBBLES_PASSWORD",
  "ALLOWED_IMESSAGE_HANDLES",
  "KIZUNA_URL",
  "KIZUNA_ENABLED",
] as const;

class ProcessExitSentinel extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${String(code)})`);
    this.code = code;
  }
}

let exitCalled = false;
const errorLog: unknown[] = [];

beforeEach(() => {
  // Clear every env key we care about (passing `undefined` deletes it). This
  // matters for Zod enum-typed fields like BROWSER_ENV — stubbing them to ""
  // would fail enum parse rather than fall through to the default.
  for (const key of RELEVANT_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  // Provide the bare minimum to make module-load parse succeed.
  vi.stubEnv("LLM_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "k");
  vi.resetModules();
  exitCalled = false;
  errorLog.length = 0;
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalled = true;
    throw new ProcessExitSentinel(code ?? 0);
  }) as never);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLog.push(...args);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function loadConfig() {
  return import("../src/config");
}

function loggedMessages(): string {
  return errorLog.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join("\n");
}

describe("validateConfig — happy path", () => {
  it("does not exit when only the configured providers' keys are set", async () => {
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).not.toThrow();
    expect(exitCalled).toBe(false);
  });
});

describe("config — Kizuna", () => {
  it("defaults KIZUNA_URL to the Portless API URL and KIZUNA_ENABLED to true", async () => {
    const { config } = await loadConfig();

    expect(config.KIZUNA_URL).toBe("https://api.kizuna.localhost");
    expect(config.KIZUNA_ENABLED).toBe(true);
  });

  it("validates and exposes a configured KIZUNA_URL", async () => {
    vi.stubEnv("KIZUNA_URL", "http://localhost:3000");
    vi.resetModules();

    const { config } = await loadConfig();

    expect(config.KIZUNA_URL).toBe("http://localhost:3000");
  });

  it.each([
    [undefined, true],
    ["", true],
    ["   ", true],
    ["true", true],
    [" true ", true],
    ["false", false],
    [" false ", false],
  ] as const)("parses KIZUNA_ENABLED=%s as %s", async (raw, expected) => {
    vi.stubEnv("KIZUNA_ENABLED", raw);
    vi.resetModules();

    const { config } = await loadConfig();

    expect(config.KIZUNA_ENABLED).toBe(expected);
  });

  it("fails module-load validation for invalid KIZUNA_URL", async () => {
    vi.stubEnv("KIZUNA_URL", "not-a-url");
    vi.resetModules();

    await expect(loadConfig()).rejects.toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/KIZUNA_URL/);
  });

  it("fails module-load validation for invalid KIZUNA_ENABLED", async () => {
    vi.stubEnv("KIZUNA_ENABLED", "yes");
    vi.resetModules();

    await expect(loadConfig()).rejects.toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/KIZUNA_ENABLED/);
  });
});

describe("validateConfig — LLM provider keys", () => {
  it("rejects anthropic provider without ANTHROPIC_API_KEY", async () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(
      /ANTHROPIC_API_KEY is required when LLM_PROVIDER is "anthropic"/,
    );
  });

  it("rejects openai provider without OPENAI_API_KEY", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/OPENAI_API_KEY is required/);
  });

  it("rejects xai provider without XAI_API_KEY", async () => {
    vi.stubEnv("LLM_PROVIDER", "xai");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/XAI_API_KEY is required/);
  });
});

describe("validateConfig — TTS", () => {
  it("rejects TTS_PROVIDER without TTS_VOICE_ID", async () => {
    vi.stubEnv("TTS_PROVIDER", "elevenlabs/eleven_flash_v2_5");
    vi.stubEnv("ELEVENLABS_API_KEY", "k");
    vi.stubEnv("TTS_VOICE_ID", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/TTS_VOICE_ID is required when TTS_PROVIDER is set/);
  });

  it('rejects TTS_PROVIDER missing the "provider/model" slash', async () => {
    vi.stubEnv("TTS_PROVIDER", "elevenlabs");
    vi.stubEnv("TTS_VOICE_ID", "voice");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/TTS_PROVIDER must be in "provider\/model" format/);
  });

  it("rejects elevenlabs TTS without ELEVENLABS_API_KEY", async () => {
    vi.stubEnv("TTS_PROVIDER", "elevenlabs/eleven_flash_v2_5");
    vi.stubEnv("TTS_VOICE_ID", "voice");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/ELEVENLABS_API_KEY is required/);
  });
});

describe("validateConfig — BlueBubbles", () => {
  it("rejects BLUEBUBBLES_HOST without BLUEBUBBLES_PASSWORD", async () => {
    vi.stubEnv("BLUEBUBBLES_HOST", "http://localhost:1234");
    vi.stubEnv("BLUEBUBBLES_PASSWORD", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/BLUEBUBBLES_PASSWORD is required/);
  });

  it("rejects ALLOWED_IMESSAGE_HANDLES without BLUEBUBBLES_HOST", async () => {
    vi.stubEnv("ALLOWED_IMESSAGE_HANDLES", "+15551234567");
    vi.stubEnv("BLUEBUBBLES_HOST", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/BLUEBUBBLES_HOST is required/);
  });
});

describe("validateConfig — Google OAuth", () => {
  it("rejects partial Google OAuth (only client id set)", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "id");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    const msgs = loggedMessages();
    expect(msgs).toMatch(/GOOGLE_OAUTH_CLIENT_SECRET is required/);
    expect(msgs).toMatch(/GOOGLE_OAUTH_REFRESH_TOKEN is required/);
  });

  it("accepts all-or-nothing — none set is valid", async () => {
    // (covered by the happy-path test above too, but worth being explicit)
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).not.toThrow();
  });
});

describe("validateConfig — STT", () => {
  it('rejects STT_PROVIDER missing the "provider/model" slash', async () => {
    vi.stubEnv("STT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "k");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/STT_PROVIDER must be in "provider\/model" format/);
  });

  it("rejects an unknown STT provider", async () => {
    vi.stubEnv("STT_PROVIDER", "deepgram/nova-2");
    vi.stubEnv("STT_API_KEY", "k");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/STT_PROVIDER unknown provider "deepgram"/);
  });

  it("rejects openai STT without STT_API_KEY or OPENAI_API_KEY", async () => {
    vi.stubEnv("STT_PROVIDER", "openai/whisper-1");
    vi.stubEnv("STT_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/STT_API_KEY or OPENAI_API_KEY is required/);
  });

  it("accepts openai STT when only OPENAI_API_KEY is set (STT_API_KEY unset)", async () => {
    vi.stubEnv("STT_PROVIDER", "openai/whisper-1");
    vi.stubEnv("OPENAI_API_KEY", "k");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).not.toThrow();
  });

  it('accepts STT_API_KEY="" falling through to OPENAI_API_KEY', async () => {
    // Common .env shape: `STT_API_KEY=` produces "" (not undefined). The
    // fallback must treat empty string the same as unset.
    vi.stubEnv("STT_PROVIDER", "openai/whisper-1");
    vi.stubEnv("STT_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "k");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).not.toThrow();
  });
});

describe("validateConfig — image generation", () => {
  it('rejects IMAGE_GENERATION_MODEL missing the "provider/model" slash', async () => {
    vi.stubEnv("IMAGE_GENERATION_MODEL", "grok-imagine-image");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(/IMAGE_GENERATION_MODEL must be in "provider\/model" format/);
  });

  it("rejects xai-provider image model without XAI_API_KEY", async () => {
    vi.stubEnv("IMAGE_GENERATION_MODEL", "xai/grok-imagine-image");
    vi.stubEnv("XAI_API_KEY", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(
      /XAI_API_KEY is required when IMAGE_GENERATION_MODEL uses "xai" provider/,
    );
  });
});

describe("validateConfig — browser cloud mode", () => {
  it("rejects cloud browser without BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID", async () => {
    vi.stubEnv("BROWSER_ENABLED", "true");
    vi.stubEnv("BROWSER_ENV", "cloud");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    const msgs = loggedMessages();
    expect(msgs).toMatch(/BROWSERBASE_API_KEY is required/);
    expect(msgs).toMatch(/BROWSERBASE_PROJECT_ID is required/);
  });

  it("accepts local browser mode without browserbase keys", async () => {
    vi.stubEnv("BROWSER_ENABLED", "true");
    vi.stubEnv("BROWSER_ENV", "local");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).not.toThrow();
  });
});

describe("validateConfig — location", () => {
  it("defaults place-learning thresholds", async () => {
    const { config } = await loadConfig();

    expect(config.PLACE_LEARNING_VISITS).toBe(3);
    expect(config.PLACE_LEARNING_RADIUS_M).toBe(200);
    expect(config.PLACE_LEARNING_WINDOW_DAYS).toBe(30);
  });

  it("parses place-learning threshold overrides", async () => {
    vi.stubEnv("PLACE_LEARNING_VISITS", "5");
    vi.stubEnv("PLACE_LEARNING_RADIUS_M", "125.5");
    vi.stubEnv("PLACE_LEARNING_WINDOW_DAYS", "14");
    vi.resetModules();

    const { config } = await loadConfig();

    expect(config.PLACE_LEARNING_VISITS).toBe(5);
    expect(config.PLACE_LEARNING_RADIUS_M).toBe(125.5);
    expect(config.PLACE_LEARNING_WINDOW_DAYS).toBe(14);
  });

  it("rejects LOCATION_ENABLED without GOOGLE_MAPS_API_KEY", async () => {
    vi.stubEnv("LOCATION_ENABLED", "true");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    vi.resetModules();
    const { validateConfig } = await loadConfig();
    expect(() => validateConfig()).toThrow(ProcessExitSentinel);
    expect(loggedMessages()).toMatch(
      /GOOGLE_MAPS_API_KEY is required when LOCATION_ENABLED is true/,
    );
  });
});
