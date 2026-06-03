import { fakeAdapter } from "@kokoro/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The registry's behavior is governed entirely by `config` flags:
 *   - KAO_URL gates email/calendar/reminders + the gated confirmation
 *     primitive (Google services are vended by Kao).
 *   - BROWSER_ENABLED gates browse + (also) the confirmation primitive.
 *   - IMAGE_GENERATION_MODEL gates sendPhoto.
 *   - TTS_PROVIDER gates sendVoice.
 *
 * Mock `@kokoro/shared.config` per test by overriding via vi.hoisted +
 * `vi.resetModules()` so each scenario re-loads the registry against the
 * scenario's config.
 */

const { mockConfig } = vi.hoisted(() => {
  const mockConfig: Record<string, unknown> = {};
  return { mockConfig };
});

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig()),
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

vi.mock("../../../src/services/routine-executor", () => ({
  // Allow up to 3 levels of nesting; the registry uses this constant to gate
  // useRoutine registration.
  MAX_ROUTINE_DEPTH: 3,
  executeRoutine: vi.fn(),
}));

// Mock the MCP manager so these tests don't load @ai-sdk/mcp or touch runtime
// state. Default returns no tools, keeping the exact-match baseline below valid.
vi.mock("../../../src/services/mcp", () => ({
  getMcpTools: vi.fn(() => ({})),
}));

// proposeRoutine pulls in the confirmation rail + db; stub it to a sentinel so
// the registry tests stay focused on which palette it lands in.
vi.mock("../../../src/ai/tools/routine-proposals", () => ({
  createProposeRoutineTool: vi.fn(() => ({ __proposeRoutine: true })),
}));

// proposeRoutineRefinement likewise pulls in the db + confirmation rail; stub
// it so these palette tests stay focused on which tools land where.
vi.mock("../../../src/ai/tools/routine-refinements", () => ({
  createProposeRoutineRefinementTool: vi.fn(() => ({ __proposeRoutineRefinement: true })),
}));

import { allTools, watcherTools, routineToolsUnderWatcher } from "../../../src/ai/tools/index";
import { getMcpTools } from "../../../src/services/mcp";

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
  mockConfig.KIZUNA_ENABLED = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("allTools — minimum-config baseline", () => {
  it("registers the always-on tools (routine mgmt, watcher mgmt, memory, CRM read+write, confirmation primitives) with KIZUNA_ENABLED on", () => {
    // KIZUNA_ENABLED is set in beforeEach, so CRM reads + writes are present,
    // and writes being gated triggers the confirmation primitives.
    const tools = allTools(baseCtx);
    const names = Object.keys(tools).sort();
    expect(names).toEqual(
      [
        "cancelConfirmation",
        "createFollowup",
        "findPeople",
        "getPersonContext",
        "listMyFollowups",
        "logInteraction",
        "manageRoutines",
        "manageWatchers",
        "recentInteractions",
        "rememberFact",
        "requestConfirmation",
        "resolveFollowup",
        "searchMemory",
        "searchRoutines",
        "updatePerson",
        "useRoutine",
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
    mockConfig.KAO_URL = "stub";
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

  it("omits CRM read AND write tools when parsed KIZUNA_ENABLED is false", () => {
    mockConfig.KIZUNA_ENABLED = false;

    const all = Object.keys(allTools(baseCtx));
    const watcher = Object.keys(watcherTools(baseCtx));
    const routine = Object.keys(routineToolsUnderWatcher(baseCtx));
    for (const names of [all, watcher, routine]) {
      expect(names).not.toContain("findPeople");
      expect(names).not.toContain("getPersonContext");
      expect(names).not.toContain("recentInteractions");
      expect(names).not.toContain("listMyFollowups");
      // Write tools must never leak out either, even in `allTools` — they
      // depend on KIZUNA_ENABLED too, so if someone moves the registration
      // outside the guard this assertion catches the regression.
      expect(names).not.toContain("logInteraction");
      expect(names).not.toContain("createFollowup");
      expect(names).not.toContain("resolveFollowup");
      expect(names).not.toContain("updatePerson");
    }
  });

  it("does NOT register confirmation primitives when no gated tool is enabled (no Google OAuth, no browser, no Kizuna writes)", () => {
    mockConfig.KIZUNA_ENABLED = false;
    const names = Object.keys(allTools(baseCtx));
    expect(names).not.toContain("requestConfirmation");
    expect(names).not.toContain("cancelConfirmation");
  });

  it("registers confirmation primitives when KIZUNA_ENABLED alone is on (CRM writes are gated)", () => {
    const names = Object.keys(allTools(baseCtx));
    expect(names).toContain("requestConfirmation");
    expect(names).toContain("cancelConfirmation");
    expect(names).toEqual(
      expect.arrayContaining([
        "logInteraction",
        "createFollowup",
        "resolveFollowup",
        "updatePerson",
      ]),
    );
  });
});

describe("allTools — self-authored routines (proposeRoutine + proposeRoutineRefinement)", () => {
  // Both are offered ONLY on a live conversational turn (ctx.conversational
  // === true) — always on there, no feature flag.
  const convoCtx = { ...baseCtx, conversational: true };

  it("registers proposeRoutine and proposeRoutineRefinement on a conversational turn", () => {
    const names = Object.keys(allTools(convoCtx));
    expect(names).toContain("proposeRoutine");
    expect(names).toContain("proposeRoutineRefinement");
  });

  it("is NEVER offered to watcher / under-watcher palettes", () => {
    // Structural invariant: scheduled/observation runs can't self-author or
    // self-edit a routine — preserves the read-only watcher guarantee.
    for (const palette of [watcherTools(convoCtx), routineToolsUnderWatcher(convoCtx)]) {
      const names = Object.keys(palette);
      expect(names).not.toContain("proposeRoutine");
      expect(names).not.toContain("proposeRoutineRefinement");
    }
  });

  it("is withheld from every non-conversational main-context caller (routine runs, proactive)", () => {
    // Routine executions and proactive outreach call allTools under
    // callingContext "main" but leave `conversational` false — they must NOT
    // be able to self-author or self-edit a routine. Positive opt-in.
    for (const ctx of [baseCtx, { ...baseCtx, conversational: false }]) {
      const names = Object.keys(allTools(ctx));
      expect(names).not.toContain("proposeRoutine");
      expect(names).not.toContain("proposeRoutineRefinement");
    }
    // ...but a live conversational turn still gets both.
    expect(Object.keys(allTools(convoCtx))).toContain("proposeRoutine");
  });
});

describe("allTools — MCP tools", () => {
  it("merges connected MCP tools into the main palette", () => {
    vi.mocked(getMcpTools).mockReturnValueOnce({ mcp_kioku_recall: {} as never });
    const names = Object.keys(allTools(baseCtx));
    expect(names).toContain("mcp_kioku_recall");
  });

  it("never offers MCP tools to read-only watcher / under-watcher palettes", () => {
    // getMcpTools would return tools, but watcherTools/routineToolsUnderWatcher
    // don't consult it at all — the read-only invariant must hold structurally.
    vi.mocked(getMcpTools).mockReturnValue({ mcp_kioku_recall: {} as never });
    expect(Object.keys(watcherTools(baseCtx))).not.toContain("mcp_kioku_recall");
    expect(Object.keys(routineToolsUnderWatcher(baseCtx))).not.toContain("mcp_kioku_recall");
  });

  it("does not let an MCP tool shadow a built-in of the same key", () => {
    vi.mocked(getMcpTools).mockReturnValueOnce({ searchMemory: { sentinel: true } as never });
    const tools = allTools(baseCtx) as Record<string, { sentinel?: boolean }>;
    expect(tools.searchMemory.sentinel).toBeUndefined();
  });
});

describe("allTools — useRoutine recursion gate", () => {
  it("registers useRoutine when depth < MAX_ROUTINE_DEPTH", () => {
    expect(Object.keys(allTools({ ...baseCtx, routineDepth: 0 }))).toContain("useRoutine");
    expect(Object.keys(allTools({ ...baseCtx, routineDepth: 2 }))).toContain("useRoutine");
  });

  it("excludes useRoutine at MAX_ROUTINE_DEPTH (= 3)", () => {
    expect(Object.keys(allTools({ ...baseCtx, routineDepth: 3 }))).not.toContain("useRoutine");
  });
});

describe("watcherTools — read-only invariant", () => {
  it("excludes every mutating tool — sends, calendar writes, reminders, routine/watcher CRUD, confirmation primitives", () => {
    mockConfig.KAO_URL = "stub";
    mockConfig.BROWSER_ENABLED = true;
    mockConfig.IMAGE_GENERATION_MODEL = "stub";
    mockConfig.TTS_PROVIDER = "stub";

    const names = Object.keys(watcherTools(baseCtx));
    const forbidden = [
      "sendEmail",
      "sendPhoto",
      "sendVoice",
      "manageCalendar", // mutating; readOnly variant is `listCalendarEvents`
      "manageReminders",
      "manageRoutines",
      "manageWatchers",
      "requestConfirmation",
      "cancelConfirmation",
      "searchRoutines",
      "rememberFact", // mutates the vault; searchMemory (read-only) is allowed
      "logInteraction", // CRM writes — read tools are allowed
      "createFollowup",
      "resolveFollowup",
      "updatePerson",
    ];
    for (const f of forbidden) {
      expect(names, `watcherTools must not include ${f}`).not.toContain(f);
    }
  });

  it("includes the watcher-specific terminator and read-only observation tools", () => {
    mockConfig.KAO_URL = "stub";
    mockConfig.BROWSER_ENABLED = true;

    const names = Object.keys(watcherTools(baseCtx));
    expect(names).toEqual(
      expect.arrayContaining([
        "checkEmail",
        "listCalendarEvents", // the readOnly variant exposed under this name
        "browse",
        "findPeople",
        "getPersonContext",
        "listMyFollowups",
        "recentInteractions",
        "useRoutine",
        "reportWatcherResult",
        "searchMemory",
      ]),
    );
  });

  it("excludes useRoutine at MAX_ROUTINE_DEPTH", () => {
    expect(Object.keys(watcherTools({ ...baseCtx, routineDepth: 3 }))).not.toContain("useRoutine");
  });
});

describe("routineToolsUnderWatcher — read-only invariant transitive", () => {
  it("returns the same read-only subset as watcherTools — minus reportWatcherResult", () => {
    mockConfig.KAO_URL = "stub";
    mockConfig.BROWSER_ENABLED = true;

    const watcher = Object.keys(watcherTools(baseCtx)).sort();
    const routine = Object.keys(routineToolsUnderWatcher(baseCtx)).sort();
    expect(routine).toEqual(watcher.filter((n) => n !== "reportWatcherResult"));
  });

  it("does not include any mutating surface", () => {
    mockConfig.KAO_URL = "stub";
    mockConfig.BROWSER_ENABLED = true;

    const names = Object.keys(routineToolsUnderWatcher(baseCtx));
    expect(names).not.toContain("sendEmail");
    expect(names).not.toContain("manageCalendar");
    expect(names).not.toContain("requestConfirmation");
  });
});
