import { fakeAdapter } from "@mashiro/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The registry's behavior is governed entirely by `config` flags:
 *   - GOOGLE_OAUTH_CLIENT_ID gates email/calendar/reminders + the gated
 *     confirmation primitive.
 *   - BROWSER_ENABLED gates browse + (also) the confirmation primitive.
 *   - IMAGE_GENERATION_MODEL gates sendPhoto.
 *   - TTS_PROVIDER gates sendVoice.
 *
 * Mock `@mashiro/shared.config` per test by overriding via vi.hoisted +
 * `vi.resetModules()` so each scenario re-loads the registry against the
 * scenario's config.
 */

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {} as Record<string, unknown>,
}));

vi.mock("@mashiro/shared", async (orig) => ({
  ...((await orig()) as object),
  config: mockConfig,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock("../../../src/services/skill-executor", () => ({
  // Allow up to 3 levels of nesting; the registry uses this constant to gate
  // useSkill registration.
  MAX_SKILL_DEPTH: 3,
  executeSkill: vi.fn(),
}));

import { allTools, watcherTools, skillToolsUnderWatcher } from "../../../src/ai/tools/index";

const adapter = fakeAdapter();
const baseCtx = {
  chatId: "chat-1",
  adapter,
  sessionId: "sess-1",
};

beforeEach(() => {
  // Wipe and re-seed mockConfig before each test. Keys removed via delete so
  // optional checks (config.X being undefined) actually flow through.
  for (const key of Object.keys(mockConfig)) {
    delete mockConfig[key];
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("allTools — minimum-config baseline", () => {
  it("registers the always-on tools (memory, skill mgmt, watcher mgmt) with no flags set", () => {
    const tools = allTools(baseCtx);
    const names = Object.keys(tools).sort();
    expect(names).toEqual(
      [
        "curateMemory",
        "listMemories",
        "manageSkills",
        "manageWatchers",
        "noteToSelf",
        "readMemory",
        "rememberFact",
        "searchMemory",
        "searchSkills",
        "useSkill",
      ].sort(),
    );
  });
});

describe("allTools — feature flags", () => {
  it("registers sendPhoto when IMAGE_GENERATION_MODEL is set", () => {
    mockConfig.IMAGE_GENERATION_MODEL = "xai/grok-imagine-image";
    expect(Object.keys(allTools(baseCtx))).toContain("sendPhoto");
  });

  it("registers sendVoice when TTS_PROVIDER is set", () => {
    mockConfig.TTS_PROVIDER = "elevenlabs/eleven_flash_v2_5";
    expect(Object.keys(allTools(baseCtx))).toContain("sendVoice");
  });

  it("registers email + calendar + reminders + confirmation primitives when Google OAuth is set", () => {
    mockConfig.GOOGLE_OAUTH_CLIENT_ID = "stub";
    const names = Object.keys(allTools(baseCtx));
    expect(names).toEqual(
      expect.arrayContaining([
        "checkEmail",
        "sendEmail",
        "manageCalendar",
        "manageReminders",
        "requestConfirmation",
        "cancelConfirmation",
      ]),
    );
  });

  it("registers browse + confirmation primitives when BROWSER_ENABLED is true", () => {
    mockConfig.BROWSER_ENABLED = true;
    const names = Object.keys(allTools(baseCtx));
    expect(names).toContain("browse");
    expect(names).toContain("requestConfirmation");
    expect(names).toContain("cancelConfirmation");
  });

  it("does NOT register confirmation primitives when neither Google OAuth nor browser is enabled", () => {
    const names = Object.keys(allTools(baseCtx));
    expect(names).not.toContain("requestConfirmation");
    expect(names).not.toContain("cancelConfirmation");
  });
});

describe("allTools — useSkill recursion gate", () => {
  it("registers useSkill when depth < MAX_SKILL_DEPTH", () => {
    expect(Object.keys(allTools({ ...baseCtx, skillDepth: 0 }))).toContain("useSkill");
    expect(Object.keys(allTools({ ...baseCtx, skillDepth: 2 }))).toContain("useSkill");
  });

  it("excludes useSkill at MAX_SKILL_DEPTH (= 3)", () => {
    expect(Object.keys(allTools({ ...baseCtx, skillDepth: 3 }))).not.toContain("useSkill");
  });
});

describe("watcherTools — read-only invariant", () => {
  it("excludes every mutating tool — sends, memory writes, calendar writes, reminders, skill/watcher CRUD, confirmation primitives", () => {
    mockConfig.GOOGLE_OAUTH_CLIENT_ID = "stub";
    mockConfig.BROWSER_ENABLED = true;
    mockConfig.IMAGE_GENERATION_MODEL = "stub";
    mockConfig.TTS_PROVIDER = "stub";

    const names = Object.keys(watcherTools(baseCtx));
    const forbidden = [
      "sendEmail",
      "sendPhoto",
      "sendVoice",
      "rememberFact",
      "noteToSelf",
      "curateMemory",
      "manageCalendar", // mutating; readOnly variant is `listCalendarEvents`
      "manageReminders",
      "manageSkills",
      "manageWatchers",
      "requestConfirmation",
      "cancelConfirmation",
      "searchSkills",
    ];
    for (const f of forbidden) {
      expect(names, `watcherTools must not include ${f}`).not.toContain(f);
    }
  });

  it("includes the watcher-specific terminator and read-only observation tools", () => {
    mockConfig.GOOGLE_OAUTH_CLIENT_ID = "stub";
    mockConfig.BROWSER_ENABLED = true;

    const names = Object.keys(watcherTools(baseCtx));
    expect(names).toEqual(
      expect.arrayContaining([
        "readMemory",
        "searchMemory",
        "listMemories",
        "checkEmail",
        "listCalendarEvents", // the readOnly variant exposed under this name
        "browse",
        "useSkill",
        "reportWatcherResult",
      ]),
    );
  });

  it("excludes useSkill at MAX_SKILL_DEPTH", () => {
    expect(
      Object.keys(watcherTools({ ...baseCtx, skillDepth: 3 })),
    ).not.toContain("useSkill");
  });
});

describe("skillToolsUnderWatcher — read-only invariant transitive", () => {
  it("returns the same read-only subset as watcherTools — minus reportWatcherResult", () => {
    mockConfig.GOOGLE_OAUTH_CLIENT_ID = "stub";
    mockConfig.BROWSER_ENABLED = true;

    const watcher = Object.keys(watcherTools(baseCtx)).sort();
    const skill = Object.keys(skillToolsUnderWatcher(baseCtx)).sort();
    expect(skill).toEqual(watcher.filter((n) => n !== "reportWatcherResult"));
  });

  it("does not include any mutating surface", () => {
    mockConfig.GOOGLE_OAUTH_CLIENT_ID = "stub";
    mockConfig.BROWSER_ENABLED = true;

    const names = Object.keys(skillToolsUnderWatcher(baseCtx));
    expect(names).not.toContain("sendEmail");
    expect(names).not.toContain("rememberFact");
    expect(names).not.toContain("manageCalendar");
    expect(names).not.toContain("requestConfirmation");
  });
});
