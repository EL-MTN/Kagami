import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Silence the Pino logger so dispatcher info/error logs don't leak into test
// output, and hand out a mutable config copy with EXECUTE_CODE_ENABLED on
// (the executeCode dispatch re-checks the flag at run time; the test env has
// it unset). Everything else from @kokoro/shared flows through unchanged.
vi.mock("@kokoro/shared", async (orig) => {
  const real = await orig<typeof import("@kokoro/shared")>();
  return {
    ...real,
    config: { ...real.config, EXECUTE_CODE_ENABLED: true },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    },
  };
});

// Mock all underlying services BEFORE importing the module under test.
// Using factories that return vi.fn() lets each test reach in via vi.mocked()
// and assert how the dispatcher invoked them.
vi.mock("../../src/services/gmail", () => ({
  sendEmail: vi.fn(),
}));
vi.mock("../../src/services/google-calendar", () => ({
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));
vi.mock("../../src/services/browser", () => ({
  acquireBrowser: vi.fn(),
  releaseBrowser: vi.fn(),
  resetBrowser: vi.fn(),
  withBrowserLock: vi.fn(<T>(fn: () => Promise<T>) => fn()),
}));
// The dispatcher's catch checks `error instanceof CodeSandboxError`, so the
// factory must export a real class — a vi.fn() stub would fail the check.
vi.mock("../../src/services/code-sandbox", () => {
  class CodeSandboxError extends Error {
    readonly kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.name = "CodeSandboxError";
      this.kind = kind;
    }
  }
  return { runCode: vi.fn(), CodeSandboxError };
});
vi.mock("@kokoro/kizuna", () => ({
  logInteraction: vi.fn(),
  createFollowup: vi.fn(),
  resolveFollowup: vi.fn(),
  updatePerson: vi.fn(),
}));
// Mock only the db helpers the dispatcher touches for createRoutine. The
// real @kokoro/db pulls in mongoose/models we don't want to load here.
vi.mock("@kokoro/db", () => ({
  createRoutine: vi.fn(),
  createSkill: vi.fn(),
  getRoutineById: vi.fn(),
  getSkillById: vi.fn(),
  updateRoutineIfVersion: vi.fn(),
  updateSkillIfVersion: vi.fn(),
  applyRoutineRefinement: vi.fn(),
  isDuplicateKeyError: vi.fn(() => false),
  recordProposalDecision: vi.fn(),
  recordSkillProposalDecision: vi.fn(),
}));

import { config, logger } from "@kokoro/shared";
import { sendEmail } from "../../src/services/gmail";
import { updateEvent, deleteEvent } from "../../src/services/google-calendar";
import { acquireBrowser, releaseBrowser, resetBrowser } from "../../src/services/browser";
import { runCode, CodeSandboxError } from "../../src/services/code-sandbox";
import { createFollowup, logInteraction, resolveFollowup, updatePerson } from "@kokoro/kizuna";
import {
  createRoutine,
  createSkill,
  getRoutineById,
  getSkillById,
  updateRoutineIfVersion,
  updateSkillIfVersion,
  applyRoutineRefinement,
  isDuplicateKeyError,
  recordProposalDecision,
  recordSkillProposalDecision,
} from "@kokoro/db";
import {
  dispatchGatedAction,
  isGatedTool,
  GATED_TOOL_NAMES,
  recordProposalDeclineFromConfirmation,
} from "../../src/services/gated-actions";

beforeEach(() => {
  vi.mocked(sendEmail).mockReset();
  vi.mocked(updateEvent).mockReset();
  vi.mocked(deleteEvent).mockReset();
  vi.mocked(acquireBrowser).mockReset();
  vi.mocked(releaseBrowser).mockReset();
  vi.mocked(resetBrowser).mockReset();
  vi.mocked(runCode).mockReset();
  vi.mocked(logInteraction).mockReset();
  vi.mocked(createFollowup).mockReset();
  vi.mocked(resolveFollowup).mockReset();
  vi.mocked(updatePerson).mockReset();
  vi.mocked(createRoutine).mockReset();
  vi.mocked(createSkill).mockReset();
  vi.mocked(getRoutineById).mockReset();
  vi.mocked(getSkillById).mockReset();
  vi.mocked(updateRoutineIfVersion).mockReset();
  vi.mocked(updateSkillIfVersion).mockReset();
  vi.mocked(applyRoutineRefinement).mockReset();
  // recordProposalDecision is async in production (callers chain .catch on it);
  // default the mock to a resolved promise so that chaining doesn't throw.
  vi.mocked(recordProposalDecision).mockReset().mockResolvedValue(undefined);
  vi.mocked(recordSkillProposalDecision).mockReset().mockResolvedValue(undefined);
  vi.mocked(isDuplicateKeyError).mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isGatedTool", () => {
  it("returns true for every name in GATED_TOOL_NAMES", () => {
    for (const name of GATED_TOOL_NAMES) {
      expect(isGatedTool(name)).toBe(true);
    }
  });

  it("returns false for tools not in the gated set", () => {
    expect(isGatedTool("sendText")).toBe(false);
    expect(isGatedTool("createRoutine")).toBe(false);
    expect(isGatedTool("createSkill")).toBe(false);
    expect(isGatedTool("")).toBe(false);
  });

  it("currently gates the Google + browser + Kizuna write tools", () => {
    // Pinned to surface intent — adding a new gated tool should update this list
    // alongside the GATED_TOOL_NAMES literal and the dispatcher switch.
    expect([...GATED_TOOL_NAMES].sort()).toEqual([
      "browseAgent",
      "createFollowup",
      "logInteraction",
      "manageCalendar",
      "resolveFollowup",
      "sendEmail",
      "updatePerson",
    ]);
  });
});

describe("dispatchGatedAction — routing & validation", () => {
  it("rejects an unknown tool name", async () => {
    const result = await dispatchGatedAction("notATool", {});
    expect(result.success).toBe(false);
    expect(result.summary).toBe('unknown gated tool "notATool"');
    expect(result.detail.reason).toBe("unknown_tool");
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it("rejects malformed sendEmail args (missing required fields)", async () => {
    const result = await dispatchGatedAction("sendEmail", { to: "not-an-email" });
    expect(result.success).toBe(false);
    expect(result.summary).toBe("invalid arguments");
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it("rejects manageCalendar with an action other than update/delete", async () => {
    const result = await dispatchGatedAction("manageCalendar", {
      action: "list",
      eventId: "e1",
    });
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
  });

  it("rejects browseAgent with an empty goal", async () => {
    const result = await dispatchGatedAction("browseAgent", { goal: "" });
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
  });
});

describe("dispatchGatedAction — sendEmail happy path", () => {
  it("calls sendEmail and returns the threadId/id in detail", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ id: "msg-1", threadId: "th-1" });
    const result = await dispatchGatedAction("sendEmail", {
      to: "alice@example.com",
      subject: "hi",
      body: "body",
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe("email sent to alice@example.com");
    expect(result.detail).toEqual({ id: "msg-1", threadId: "th-1" });
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith("alice@example.com", "hi", "body", undefined);
  });

  it("forwards threadId/inReplyTo when present", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ id: "msg-2", threadId: "th-2" });
    await dispatchGatedAction("sendEmail", {
      to: "alice@example.com",
      subject: "re",
      body: "body",
      threadId: "th-2",
      inReplyTo: "<msg-1@example.com>",
    });
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith("alice@example.com", "re", "body", {
      threadId: "th-2",
      inReplyTo: "<msg-1@example.com>",
    });
  });

  it("propagates underlying sendEmail errors as a failed dispatch", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("gmail down"));
    const result = await dispatchGatedAction("sendEmail", {
      to: "alice@example.com",
      subject: "hi",
      body: "body",
    });
    expect(result.success).toBe(false);
    expect(result.summary).toBe("failed: gmail down");
    expect(result.detail).toEqual({ reason: "gmail down" });
  });
});

describe("dispatchGatedAction — manageCalendar", () => {
  it("delete branch calls deleteEvent and reports the event id", async () => {
    vi.mocked(deleteEvent).mockResolvedValue(undefined);
    const result = await dispatchGatedAction("manageCalendar", {
      action: "delete",
      eventId: "ev-1",
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe("calendar event ev-1 deleted");
    expect(vi.mocked(deleteEvent)).toHaveBeenCalledWith("ev-1");
    expect(vi.mocked(updateEvent)).not.toHaveBeenCalled();
  });

  it("update branch calls updateEvent with the optional fields", async () => {
    const updated = {
      id: "ev-1",
      summary: "new title",
      start: "2026-01-01T10:00:00Z",
      end: "2026-01-01T11:00:00Z",
      htmlLink: "https://calendar.google.com/event?id=ev-1",
    };
    vi.mocked(updateEvent).mockResolvedValue(updated);
    const result = await dispatchGatedAction("manageCalendar", {
      action: "update",
      eventId: "ev-1",
      summary: "new title",
      start: "2026-01-01T10:00:00Z",
      end: "2026-01-01T11:00:00Z",
    });
    expect(result.success).toBe(true);
    expect(result.detail).toEqual({ event: updated });
    expect(vi.mocked(updateEvent)).toHaveBeenCalledWith("ev-1", {
      summary: "new title",
      description: undefined,
      start: "2026-01-01T10:00:00Z",
      end: "2026-01-01T11:00:00Z",
      location: undefined,
    });
  });

  it("propagates updateEvent errors as a failed dispatch", async () => {
    vi.mocked(updateEvent).mockRejectedValue(new Error("calendar API 500"));
    const result = await dispatchGatedAction("manageCalendar", {
      action: "update",
      eventId: "ev-1",
    });
    expect(result.success).toBe(false);
    expect(result.summary).toBe("failed: calendar API 500");
  });
});

describe("dispatchGatedAction — browseAgent", () => {
  /**
   * Build a minimal Stagehand stand-in returning the supplied result from
   * `agent.execute(...)`. Cast through unknown because the real Stagehand
   * type has dozens of fields the dispatcher never touches.
   */
  function fakeStagehand(
    execute: (input: { instruction: string; maxSteps: number }) => Promise<string | object>,
  ): unknown {
    return { agent: () => ({ execute }) };
  }

  it("dispatches via withBrowserLock, returns the result text and releases the browser", async () => {
    const execute = vi.fn(() => Promise.resolve("found 3 results on page"));
    vi.mocked(acquireBrowser).mockResolvedValue(
      fakeStagehand(execute) as Awaited<ReturnType<typeof acquireBrowser>>,
    );

    const result = await dispatchGatedAction("browseAgent", { goal: "search for hacker news" });

    expect(result.success).toBe(true);
    expect(result.summary).toBe("agent finished: found 3 results on page");
    expect(result.detail).toEqual({ result: "found 3 results on page" });
    expect(execute).toHaveBeenCalledWith({
      instruction: "search for hacker news",
      maxSteps: 25,
    });
    expect(vi.mocked(releaseBrowser)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resetBrowser)).not.toHaveBeenCalled();
  });

  it("JSON-serializes a non-string agent result and truncates to 4000 chars", async () => {
    const longString = "a".repeat(5000);
    const execute = vi.fn(() => Promise.resolve({ summary: longString }));
    vi.mocked(acquireBrowser).mockResolvedValue(
      fakeStagehand(execute) as Awaited<ReturnType<typeof acquireBrowser>>,
    );

    const result = await dispatchGatedAction("browseAgent", { goal: "do a thing" });

    expect(result.success).toBe(true);
    // detail.result is sliced to 4000 chars.
    expect((result.detail.result as string).length).toBe(4000);
    // summary is sliced to 200 chars (off the JSON-stringified text).
    expect(result.summary.startsWith("agent finished: ")).toBe(true);
    expect(result.summary.length).toBeLessThanOrEqual("agent finished: ".length + 200);
  });

  it("on a generic error, releases the browser without resetting", async () => {
    const execute = vi.fn(() => Promise.reject(new Error("transient flake")));
    vi.mocked(acquireBrowser).mockResolvedValue(
      fakeStagehand(execute) as Awaited<ReturnType<typeof acquireBrowser>>,
    );

    const result = await dispatchGatedAction("browseAgent", { goal: "do a thing" });

    expect(result.success).toBe(false);
    expect(result.summary).toBe("failed: transient flake");
    expect(vi.mocked(resetBrowser)).not.toHaveBeenCalled();
    expect(vi.mocked(releaseBrowser)).toHaveBeenCalledTimes(1);
  });

  it('on a "Target closed" error, calls resetBrowser and skips releaseBrowser', async () => {
    // The dispatcher treats Target/Browser-closed messages as a sign the
    // singleton is dead. Resetting tears it down; releasing on top of that
    // would orphan callers waiting on the (now-stale) lock chain.
    const execute = vi.fn(() => Promise.reject(new Error("Target closed: browser tab gone")));
    vi.mocked(acquireBrowser).mockResolvedValue(
      fakeStagehand(execute) as Awaited<ReturnType<typeof acquireBrowser>>,
    );

    const result = await dispatchGatedAction("browseAgent", { goal: "do a thing" });

    expect(result.success).toBe(false);
    expect(vi.mocked(resetBrowser)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(releaseBrowser)).not.toHaveBeenCalled();
  });

  it('"Browser closed" error path is symmetric — resetBrowser, no releaseBrowser', async () => {
    const execute = vi.fn(() => Promise.reject(new Error("Browser closed unexpectedly")));
    vi.mocked(acquireBrowser).mockResolvedValue(
      fakeStagehand(execute) as Awaited<ReturnType<typeof acquireBrowser>>,
    );

    await dispatchGatedAction("browseAgent", { goal: "do a thing" });

    expect(vi.mocked(resetBrowser)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(releaseBrowser)).not.toHaveBeenCalled();
  });

  it("if acquireBrowser itself rejects, neither releaseBrowser nor resetBrowser runs", async () => {
    // No live instance was acquired, so there's nothing to release. resetBrowser
    // also stays put since the error message doesn't match the "Target closed"
    // / "Browser closed" patterns.
    vi.mocked(acquireBrowser).mockRejectedValue(new Error("could not start browser"));

    const result = await dispatchGatedAction("browseAgent", { goal: "do a thing" });

    expect(result.success).toBe(false);
    expect(result.summary).toBe("failed: could not start browser");
    expect(vi.mocked(releaseBrowser)).not.toHaveBeenCalled();
    expect(vi.mocked(resetBrowser)).not.toHaveBeenCalled();
  });
});

describe("dispatchGatedAction — CRM writes", () => {
  const PERSON_ID = "111111111111111111111111";
  const FOLLOWUP_ID = "333333333333333333333333";

  it("logInteraction routes to @kokoro/kizuna's logInteraction and summarizes by title", async () => {
    vi.mocked(logInteraction).mockResolvedValue({
      id: "222222222222222222222222",
      occurredAt: "2026-05-13T12:00:00.000Z",
      channel: "call",
      title: "Catch up",
      bodyExcerpt: null,
      bodyTruncated: false,
      participants: [{ personId: PERSON_ID, role: "subject" }],
      context: [],
      status: "active",
    });

    const result = await dispatchGatedAction("logInteraction", {
      occurredAt: "2026-05-13T12:00:00.000Z",
      channel: "call",
      title: "Catch up",
      participants: [{ personId: PERSON_ID, role: "subject" }],
    });

    expect(result.success).toBe(true);
    expect(result.summary).toBe("interaction logged: Catch up");
    expect(vi.mocked(logInteraction)).toHaveBeenCalledTimes(1);
  });

  it("rejects logInteraction with empty participants", async () => {
    const result = await dispatchGatedAction("logInteraction", {
      occurredAt: "2026-05-13T12:00:00.000Z",
      channel: "call",
      title: "Catch up",
      participants: [],
    });
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(logInteraction)).not.toHaveBeenCalled();
  });

  it("createFollowup routes to the client and summarizes by the hydrated person's name", async () => {
    vi.mocked(createFollowup).mockResolvedValue({
      id: FOLLOWUP_ID,
      person: {
        id: PERSON_ID,
        displayName: "Sarah Chen",
        primaryEmail: null,
        primaryOrgId: null,
        tags: [],
        lastInteractionAt: null,
      },
      direction: "i_owe",
      dueAt: null,
      status: "open",
      reasonExcerpt: "Send the deck",
      reasonTruncated: false,
      sourceInteractionId: null,
    });

    const result = await dispatchGatedAction("createFollowup", {
      personId: PERSON_ID,
      direction: "i_owe",
      reason: "Send the deck",
    });

    expect(result.success).toBe(true);
    expect(result.summary).toBe("followup created for Sarah Chen");
  });

  it("rejects createFollowup with a malformed personId", async () => {
    const result = await dispatchGatedAction("createFollowup", {
      personId: "not-an-objectid",
      direction: "i_owe",
      reason: "x",
    });
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
  });

  it("resolveFollowup forwards the target status and summarizes by it", async () => {
    vi.mocked(resolveFollowup).mockResolvedValue({
      id: FOLLOWUP_ID,
      person: {
        id: PERSON_ID,
        displayName: "Sarah Chen",
        primaryEmail: null,
        primaryOrgId: null,
        tags: [],
        lastInteractionAt: null,
      },
      direction: "i_owe",
      dueAt: null,
      status: "done",
      reasonExcerpt: "Send the deck",
      reasonTruncated: false,
      sourceInteractionId: null,
    });

    const result = await dispatchGatedAction("resolveFollowup", {
      followupId: FOLLOWUP_ID,
      status: "done",
    });

    expect(result.success).toBe(true);
    expect(result.summary).toBe("followup done");
    expect(vi.mocked(resolveFollowup)).toHaveBeenCalledWith({
      followupId: FOLLOWUP_ID,
      status: "done",
    });
  });

  it("updatePerson requires at least one field beyond personId", async () => {
    const result = await dispatchGatedAction("updatePerson", { personId: PERSON_ID });
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(updatePerson)).not.toHaveBeenCalled();
  });

  it("updatePerson routes to the client and summarizes by displayName", async () => {
    vi.mocked(updatePerson).mockResolvedValue({
      id: PERSON_ID,
      displayName: "Sarah Chen",
      primaryEmail: null,
      primaryOrgId: null,
      tags: ["close-friend"],
      lastInteractionAt: null,
    });

    const result = await dispatchGatedAction("updatePerson", {
      personId: PERSON_ID,
      tags: ["close-friend"],
    });

    expect(result.success).toBe(true);
    expect(result.summary).toBe("updated Sarah Chen");
  });

  it("propagates client errors as a failed dispatch", async () => {
    vi.mocked(logInteraction).mockRejectedValue(new Error("kizuna 500"));
    const result = await dispatchGatedAction("logInteraction", {
      occurredAt: "2026-05-13T12:00:00.000Z",
      channel: "call",
      title: "Catch up",
      participants: [{ personId: PERSON_ID, role: "subject" }],
    });
    expect(result.success).toBe(false);
    expect(result.summary).toBe("failed: kizuna 500");
  });
});

describe("dispatchGatedAction — createRoutine (dispatch-only)", () => {
  const draft = {
    signature: "morning-digest#abcd1234",
    name: "morning-digest",
    description: "Summarize unread email each morning",
    prompt: "Fetch unread email and write a 3-bullet summary for {date}.",
  };

  it("is dispatchable even though it is NOT in the requestConfirmation enum", () => {
    // The model can never select it via requestConfirmation (isGatedTool false),
    // but the approval rail can still dispatch it.
    expect(isGatedTool("createRoutine")).toBe(false);
    expect(GATED_TOOL_NAMES as readonly string[]).not.toContain("createRoutine");
  });

  it("creates a read-only, on-demand routine and records the accept", async () => {
    vi.mocked(createRoutine).mockResolvedValue({ _id: "routine-1" } as never);

    const result = await dispatchGatedAction("createRoutine", draft, { chatId: "chat-1" });

    expect(result.success).toBe(true);
    expect(result.summary).toBe('routine "morning-digest" saved (on-demand)');
    expect(result.detail).toEqual({ routineId: "routine-1" });

    // Safe defaults are applied at dispatch, not taken from the draft.
    expect(vi.mocked(createRoutine)).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        name: "morning-digest",
        cronSchedule: null,
        purity: "read",
        reportMode: "always",
        enabled: true,
        nextRunAt: null,
      }),
    );
    // signature is NOT persisted onto the routine.
    expect(vi.mocked(createRoutine).mock.calls[0][1]).not.toHaveProperty("signature");

    expect(vi.mocked(recordProposalDecision)).toHaveBeenCalledWith(
      "chat-1",
      draft.signature,
      "accepted",
      expect.any(Object),
    );
  });

  it("fails cleanly when chat context is missing (never trusts args for chatId)", async () => {
    const result = await dispatchGatedAction("createRoutine", draft);
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("no_chat_context");
    expect(vi.mocked(createRoutine)).not.toHaveBeenCalled();
  });

  it("rejects a draft with no prompt before touching the db", async () => {
    const result = await dispatchGatedAction(
      "createRoutine",
      { signature: "x#1", name: "n", description: "d" },
      { chatId: "chat-1" },
    );
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(createRoutine)).not.toHaveBeenCalled();
  });

  it("treats a duplicate name as a graceful no-op and still records the accept", async () => {
    vi.mocked(createRoutine).mockRejectedValue(new Error("E11000 dup key"));
    vi.mocked(isDuplicateKeyError).mockReturnValue(true);

    const result = await dispatchGatedAction("createRoutine", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.summary).toBe('a routine named "morning-digest" already exists');
    expect(result.detail.reason).toBe("duplicate_name");
    expect(vi.mocked(recordProposalDecision)).toHaveBeenCalledWith(
      "chat-1",
      draft.signature,
      "accepted",
      expect.any(Object),
    );
  });

  it("propagates a non-duplicate db error as a failed dispatch", async () => {
    vi.mocked(createRoutine).mockRejectedValue(new Error("mongo down"));
    vi.mocked(isDuplicateKeyError).mockReturnValue(false);

    const result = await dispatchGatedAction("createRoutine", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.summary).toBe("failed: mongo down");
  });
});

describe("dispatchGatedAction — createSkill (dispatch-only)", () => {
  const draft = {
    signature: "meeting-followup-style#abcd1234",
    name: "meeting-followup-style",
    description: "Write followups after meetings",
    body: "Use concise bullets and a single next action.",
    triggers: ["after a meeting"],
    tags: ["writing"],
  };

  it("is dispatchable even though it is NOT in the requestConfirmation enum", () => {
    expect(isGatedTool("createSkill")).toBe(false);
    expect(GATED_TOOL_NAMES as readonly string[]).not.toContain("createSkill");
  });

  it("creates an enabled distilled skill and records the accept", async () => {
    vi.mocked(createSkill).mockResolvedValue({ _id: "skill-1" } as never);

    const result = await dispatchGatedAction("createSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(true);
    expect(result.summary).toBe('skill "meeting-followup-style" saved');
    expect(result.detail).toEqual({ skillId: "skill-1" });
    expect(vi.mocked(createSkill)).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        name: draft.name,
        body: draft.body,
        triggers: draft.triggers,
        tags: draft.tags,
        enabled: true,
        source: "distilled",
      }),
    );
    expect(vi.mocked(createSkill).mock.calls[0][1]).not.toHaveProperty("signature");
    expect(vi.mocked(recordSkillProposalDecision)).toHaveBeenCalledWith(
      "chat-1",
      draft.signature,
      "accepted",
      expect.any(Object),
    );
  });

  it("fails cleanly when chat context is missing", async () => {
    const result = await dispatchGatedAction("createSkill", draft);
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("no_chat_context");
    expect(vi.mocked(createSkill)).not.toHaveBeenCalled();
  });

  it("rejects malformed skill names before touching the db", async () => {
    const result = await dispatchGatedAction(
      "createSkill",
      { ...draft, name: "Bad Name" },
      { chatId: "chat-1" },
    );
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(createSkill)).not.toHaveBeenCalled();
  });

  it("treats a duplicate name as a graceful no-op and still records the accept", async () => {
    vi.mocked(createSkill).mockRejectedValue(new Error("E11000 dup key"));
    vi.mocked(isDuplicateKeyError).mockReturnValue(true);

    const result = await dispatchGatedAction("createSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.summary).toBe('a skill named "meeting-followup-style" already exists');
    expect(result.detail.reason).toBe("duplicate_name");
    expect(vi.mocked(recordSkillProposalDecision)).toHaveBeenCalledWith(
      "chat-1",
      draft.signature,
      "accepted",
      expect.any(Object),
    );
  });

  it("propagates a non-duplicate db error as a failed dispatch", async () => {
    vi.mocked(createSkill).mockRejectedValue(new Error("mongo down"));
    vi.mocked(isDuplicateKeyError).mockReturnValue(false);

    const result = await dispatchGatedAction("createSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.summary).toBe("failed: mongo down");
  });
});

describe("dispatchGatedAction — updateRoutinePrompt (dispatch-only)", () => {
  const ROUTINE_ID = "444444444444444444444444";
  const draft = {
    signature: `refine:${ROUTINE_ID}#1#abcd1234`,
    routineId: ROUTINE_ID,
    baseVersion: 1,
    newPrompt: "Improved: fetch unread email and write a 3-bullet summary for {date}.",
  };

  it("is dispatchable even though it is NOT in the requestConfirmation enum", () => {
    expect(isGatedTool("updateRoutinePrompt")).toBe(false);
    expect(GATED_TOOL_NAMES as readonly string[]).not.toContain("updateRoutinePrompt");
  });

  it("applies the version-guarded edit (prompt only), arms loop-closure tracking, records NO decision", async () => {
    vi.mocked(applyRoutineRefinement).mockResolvedValue({
      name: "morning-digest",
      version: 2,
    } as never);

    const result = await dispatchGatedAction("updateRoutinePrompt", draft, { chatId: "chat-1" });

    expect(result.success).toBe(true);
    expect(result.summary).toBe('routine "morning-digest" updated (v2)');
    expect(result.detail).toEqual({ routineId: ROUTINE_ID, version: 2 });

    // Atomic compare-and-set against baseVersion (the helper bumps version);
    // no trackForRegression in the draft → tracking armed by default.
    expect(vi.mocked(applyRoutineRefinement)).toHaveBeenCalledWith(
      ROUTINE_ID,
      "chat-1",
      1,
      { prompt: draft.newPrompt },
      { trackForRegression: true },
    );
    // The refinement can never escalate scope — these never reach the patch.
    const patch = vi.mocked(applyRoutineRefinement).mock.calls[0][3];
    expect(patch).not.toHaveProperty("purity");
    expect(patch).not.toHaveProperty("cronSchedule");
    expect(patch).not.toHaveProperty("reportMode");
    expect(patch).not.toHaveProperty("enabled");
    expect(patch).not.toHaveProperty("parameters"); // none supplied this run
    // No accept is recorded: the prompt now equals the approved one (the
    // proposeRefinement equality guard blocks an identical re-proposal).
    expect(vi.mocked(recordProposalDecision)).not.toHaveBeenCalled();
  });

  it("forwards newParameters only when supplied", async () => {
    vi.mocked(applyRoutineRefinement).mockResolvedValue({ name: "r", version: 2 } as never);

    await dispatchGatedAction(
      "updateRoutinePrompt",
      {
        ...draft,
        newParameters: [{ name: "date", type: "string", description: "the day", required: false }],
      },
      { chatId: "chat-1" },
    );

    expect(vi.mocked(applyRoutineRefinement).mock.calls[0][3]).toHaveProperty("parameters");
  });

  it("clears regression tracking (trackForRegression:false) for a revert", async () => {
    vi.mocked(applyRoutineRefinement).mockResolvedValue({ name: "r", version: 2 } as never);

    await dispatchGatedAction(
      "updateRoutinePrompt",
      { ...draft, trackForRegression: false },
      { chatId: "chat-1" },
    );

    expect(vi.mocked(applyRoutineRefinement).mock.calls[0][4]).toEqual({
      trackForRegression: false,
    });
  });

  it("reports version_conflict when the atomic update is rejected and the routine still exists", async () => {
    vi.mocked(applyRoutineRefinement).mockResolvedValue(null);
    vi.mocked(getRoutineById).mockResolvedValue({ name: "morning-digest", version: 5 } as never);

    const result = await dispatchGatedAction("updateRoutinePrompt", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("version_conflict");
    expect(result.detail).toMatchObject({ expected: 1, actual: 5 });
    expect(vi.mocked(recordProposalDecision)).not.toHaveBeenCalled();
  });

  it("reports not_found when the atomic update is rejected and the routine is gone", async () => {
    vi.mocked(applyRoutineRefinement).mockResolvedValue(null);
    vi.mocked(getRoutineById).mockResolvedValue(null);

    const result = await dispatchGatedAction("updateRoutinePrompt", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("not_found");
  });

  it("fails cleanly when chat context is missing (never trusts args for chatId)", async () => {
    const result = await dispatchGatedAction("updateRoutinePrompt", draft);
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("no_chat_context");
    expect(vi.mocked(applyRoutineRefinement)).not.toHaveBeenCalled();
  });

  it("rejects a malformed draft (missing newPrompt) before touching the db", async () => {
    const result = await dispatchGatedAction(
      "updateRoutinePrompt",
      { signature: "x", routineId: ROUTINE_ID, baseVersion: 1 },
      { chatId: "chat-1" },
    );
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(applyRoutineRefinement)).not.toHaveBeenCalled();
  });
});

describe("dispatchGatedAction — disableRoutine (dispatch-only)", () => {
  const ROUTINE_ID = "555555555555555555555555";
  const draft = { signature: `retire:${ROUTINE_ID}#1`, routineId: ROUTINE_ID, baseVersion: 1 };

  it("is dispatchable even though it is NOT in the requestConfirmation enum", () => {
    expect(isGatedTool("disableRoutine")).toBe(false);
    expect(GATED_TOOL_NAMES as readonly string[]).not.toContain("disableRoutine");
  });

  it("disables via the version-guarded helper (never deletes), records NO decision", async () => {
    vi.mocked(updateRoutineIfVersion).mockResolvedValue({
      name: "stale-digest",
      version: 2,
    } as never);

    const result = await dispatchGatedAction("disableRoutine", draft, { chatId: "chat-1" });

    expect(result.success).toBe(true);
    expect(result.summary).toBe('routine "stale-digest" disabled');
    expect(vi.mocked(updateRoutineIfVersion)).toHaveBeenCalledWith(ROUTINE_ID, "chat-1", 1, {
      enabled: false,
    });
    // No accept: a re-enabled routine must be reviewable again, not suppressed.
    expect(vi.mocked(recordProposalDecision)).not.toHaveBeenCalled();
  });

  it("reports version_conflict when rejected and the routine still exists", async () => {
    vi.mocked(updateRoutineIfVersion).mockResolvedValue(null);
    vi.mocked(getRoutineById).mockResolvedValue({ name: "stale-digest", version: 5 } as never);

    const result = await dispatchGatedAction("disableRoutine", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("version_conflict");
    expect(vi.mocked(recordProposalDecision)).not.toHaveBeenCalled();
  });

  it("reports not_found when rejected and the routine is gone", async () => {
    vi.mocked(updateRoutineIfVersion).mockResolvedValue(null);
    vi.mocked(getRoutineById).mockResolvedValue(null);

    const result = await dispatchGatedAction("disableRoutine", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("not_found");
  });

  it("fails cleanly when chat context is missing", async () => {
    const result = await dispatchGatedAction("disableRoutine", draft);
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("no_chat_context");
    expect(vi.mocked(updateRoutineIfVersion)).not.toHaveBeenCalled();
  });
});

describe("dispatchGatedAction — updateSkill (dispatch-only)", () => {
  const SKILL_ID = "666666666666666666666666";
  const draft = {
    signature: `skill-refine:${SKILL_ID}#1#abcd1234`,
    skillId: SKILL_ID,
    baseVersion: 1,
    newBody: "Refreshed: use concise bullets and a single next action.",
  };

  it("is dispatchable even though it is NOT in the requestConfirmation enum", () => {
    expect(isGatedTool("updateSkill")).toBe(false);
    expect(GATED_TOOL_NAMES as readonly string[]).not.toContain("updateSkill");
  });

  it("applies the version-guarded content edit, records NO decision", async () => {
    vi.mocked(updateSkillIfVersion).mockResolvedValue({
      name: "meeting-followup-style",
      version: 2,
    } as never);

    const result = await dispatchGatedAction("updateSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(true);
    expect(result.summary).toBe('skill "meeting-followup-style" updated (v2)');
    expect(result.detail).toEqual({ skillId: SKILL_ID, version: 2 });

    // Atomic compare-and-set against baseVersion; only the supplied content
    // fields reach the patch.
    expect(vi.mocked(updateSkillIfVersion)).toHaveBeenCalledWith(SKILL_ID, "chat-1", 1, {
      body: draft.newBody,
    });
    // Curation can never rename, re-enable, or re-source a skill.
    const patch = vi.mocked(updateSkillIfVersion).mock.calls[0][3];
    expect(patch).not.toHaveProperty("name");
    expect(patch).not.toHaveProperty("enabled");
    expect(patch).not.toHaveProperty("source");
    // No accept is recorded: the signature is version-scoped and the version
    // just bumped, so it could never match a future proposal anyway.
    expect(vi.mocked(recordSkillProposalDecision)).not.toHaveBeenCalled();
  });

  it("forwards the optional metadata fields only when supplied", async () => {
    vi.mocked(updateSkillIfVersion).mockResolvedValue({ name: "s", version: 2 } as never);

    await dispatchGatedAction(
      "updateSkill",
      { ...draft, newDescription: "Sharper one-liner", newTriggers: ["after a meeting"] },
      { chatId: "chat-1" },
    );

    expect(vi.mocked(updateSkillIfVersion)).toHaveBeenCalledWith(SKILL_ID, "chat-1", 1, {
      body: draft.newBody,
      description: "Sharper one-liner",
      triggers: ["after a meeting"],
    });
  });

  it("rejects a draft with no content fields at all", async () => {
    const result = await dispatchGatedAction(
      "updateSkill",
      { signature: "x", skillId: SKILL_ID, baseVersion: 1 },
      { chatId: "chat-1" },
    );
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(updateSkillIfVersion)).not.toHaveBeenCalled();
  });

  it("reports version_conflict when the atomic update is rejected and the skill still exists", async () => {
    vi.mocked(updateSkillIfVersion).mockResolvedValue(null);
    vi.mocked(getSkillById).mockResolvedValue({
      name: "meeting-followup-style",
      version: 5,
    } as never);

    const result = await dispatchGatedAction("updateSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("version_conflict");
    expect(result.detail).toMatchObject({ expected: 1, actual: 5 });
  });

  it("reports not_found when the atomic update is rejected and the skill is gone", async () => {
    vi.mocked(updateSkillIfVersion).mockResolvedValue(null);
    vi.mocked(getSkillById).mockResolvedValue(null);

    const result = await dispatchGatedAction("updateSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("not_found");
  });

  it("reports state_conflict when the skill was archived after the proposal (version unchanged — toggles don't bump it)", async () => {
    vi.mocked(updateSkillIfVersion).mockResolvedValue(null);
    vi.mocked(getSkillById).mockResolvedValue({
      name: "meeting-followup-style",
      version: 1, // same version the bubble was raised against...
      enabled: false, // ...but the user archived it from the dashboard
    } as never);

    const result = await dispatchGatedAction("updateSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("state_conflict");
    expect(result.summary).toContain("archived after this was proposed");
  });

  it("fails cleanly when chat context is missing", async () => {
    const result = await dispatchGatedAction("updateSkill", draft);
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("no_chat_context");
    expect(vi.mocked(updateSkillIfVersion)).not.toHaveBeenCalled();
  });
});

describe("dispatchGatedAction — disableSkill (dispatch-only)", () => {
  const SKILL_ID = "777777777777777777777777";
  const draft = { signature: `skill-archive:${SKILL_ID}#1`, skillId: SKILL_ID, baseVersion: 1 };

  it("is dispatchable even though it is NOT in the requestConfirmation enum", () => {
    expect(isGatedTool("disableSkill")).toBe(false);
    expect(GATED_TOOL_NAMES as readonly string[]).not.toContain("disableSkill");
  });

  it("archives via the version-guarded helper (never deletes), records NO decision", async () => {
    vi.mocked(updateSkillIfVersion).mockResolvedValue({
      name: "stale-skill",
      version: 2,
    } as never);

    const result = await dispatchGatedAction("disableSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(true);
    expect(result.summary).toBe('skill "stale-skill" archived');
    expect(vi.mocked(updateSkillIfVersion)).toHaveBeenCalledWith(SKILL_ID, "chat-1", 1, {
      enabled: false,
    });
    // No accept: a re-enabled skill must be reviewable again, not suppressed.
    expect(vi.mocked(recordSkillProposalDecision)).not.toHaveBeenCalled();
  });

  it("reports version_conflict when rejected and the skill still exists", async () => {
    vi.mocked(updateSkillIfVersion).mockResolvedValue(null);
    vi.mocked(getSkillById).mockResolvedValue({ name: "stale-skill", version: 5 } as never);

    const result = await dispatchGatedAction("disableSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("version_conflict");
  });

  it("reports not_found when rejected and the skill is gone", async () => {
    vi.mocked(updateSkillIfVersion).mockResolvedValue(null);
    vi.mocked(getSkillById).mockResolvedValue(null);

    const result = await dispatchGatedAction("disableSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("not_found");
  });

  it("treats an already-archived skill (same version) as success — the approved end-state already holds", async () => {
    vi.mocked(updateSkillIfVersion).mockResolvedValue(null);
    vi.mocked(getSkillById).mockResolvedValue({
      name: "stale-skill",
      version: 1, // unchanged — the user archived it from the dashboard
      enabled: false,
    } as never);

    const result = await dispatchGatedAction("disableSkill", draft, { chatId: "chat-1" });

    expect(result.success).toBe(true);
    expect(result.summary).toBe('skill "stale-skill" was already archived');
    expect(result.detail).toEqual({ skillId: SKILL_ID, alreadyArchived: true });
  });

  it("fails cleanly when chat context is missing", async () => {
    const result = await dispatchGatedAction("disableSkill", draft);
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("no_chat_context");
    expect(vi.mocked(updateSkillIfVersion)).not.toHaveBeenCalled();
  });
});

describe("dispatchGatedAction — mergeSkills (dispatch-only)", () => {
  const SURVIVOR_ID = "888888888888888888888888";
  const ABSORBED_A = "999999999999999999999999";
  const ABSORBED_B = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const draft = {
    signature: `skill-merge:${SURVIVOR_ID}#1<${ABSORBED_A}#2#abcd1234`,
    skillId: SURVIVOR_ID,
    baseVersion: 1,
    absorbed: [
      { skillId: ABSORBED_A, baseVersion: 2 },
      { skillId: ABSORBED_B, baseVersion: 1 },
    ],
    newBody: "Merged: everything still valuable from both skills.",
  };

  it("is dispatchable even though it is NOT in the requestConfirmation enum", () => {
    expect(isGatedTool("mergeSkills")).toBe(false);
    expect(GATED_TOOL_NAMES as readonly string[]).not.toContain("mergeSkills");
  });

  /** Preflight reads: both absorbees still at their proposed baseVersions. */
  function mockAbsorbeePreflightOk() {
    vi.mocked(getSkillById)
      .mockResolvedValueOnce({ name: "dupe-a", version: 2, enabled: true } as never)
      .mockResolvedValueOnce({ name: "dupe-b", version: 1, enabled: true } as never);
  }

  it("updates the survivor first, then archives every absorbed skill (one approved action)", async () => {
    mockAbsorbeePreflightOk();
    vi.mocked(updateSkillIfVersion)
      .mockResolvedValueOnce({ name: "survivor", version: 2 } as never) // survivor content
      .mockResolvedValueOnce({ name: "dupe-a", version: 3 } as never) // absorb A
      .mockResolvedValueOnce({ name: "dupe-b", version: 2 } as never); // absorb B

    const result = await dispatchGatedAction("mergeSkills", draft, { chatId: "chat-1" });

    expect(result.success).toBe(true);
    expect(result.summary).toBe('skills merged into "survivor" (v2) — archived "dupe-a", "dupe-b"');
    expect(result.detail).toEqual({
      skillId: SURVIVOR_ID,
      version: 2,
      archived: ["dupe-a", "dupe-b"],
    });

    const calls = vi.mocked(updateSkillIfVersion).mock.calls;
    expect(calls).toHaveLength(3);
    // Survivor-first ordering, with the merged content.
    expect(calls[0]).toEqual([SURVIVOR_ID, "chat-1", 1, { body: draft.newBody }]);
    // Each absorbee is disabled against ITS OWN baseVersion.
    expect(calls[1]).toEqual([ABSORBED_A, "chat-1", 2, { enabled: false }]);
    expect(calls[2]).toEqual([ABSORBED_B, "chat-1", 1, { enabled: false }]);
    // The absorbee preflight runs BEFORE the survivor write — a stale absorbee
    // must be caught while nothing has been mutated.
    const preflightOrder = vi.mocked(getSkillById).mock.invocationCallOrder;
    const survivorWriteOrder = vi.mocked(updateSkillIfVersion).mock.invocationCallOrder[0];
    expect(Math.max(...preflightOrder)).toBeLessThan(survivorWriteOrder ?? 0);
    expect(vi.mocked(recordSkillProposalDecision)).not.toHaveBeenCalled();
  });

  it("cancels the merge in preflight — nothing written — when an absorbee changed or is gone", async () => {
    vi.mocked(getSkillById)
      .mockResolvedValueOnce(null) // absorb A: deleted from the dashboard
      .mockResolvedValueOnce({ name: "dupe-b", version: 7, enabled: true } as never); // absorb B: edited

    const result = await dispatchGatedAction("mergeSkills", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.summary).toContain("merge cancelled, nothing changed");
    expect(result.detail).toEqual({
      reason: "version_conflict",
      skillId: SURVIVOR_ID,
      failed: [
        { skillId: ABSORBED_A, reason: "not_found" },
        { skillId: ABSORBED_B, reason: "version_conflict" },
      ],
    });
    // The survivor was never touched — the merged body did not land.
    expect(vi.mocked(updateSkillIfVersion)).not.toHaveBeenCalled();
  });

  it("lets an absorbee already archived at its baseVersion pass preflight", async () => {
    vi.mocked(getSkillById)
      .mockResolvedValueOnce({ name: "dupe-a", version: 2, enabled: false } as never) // archived, same version
      .mockResolvedValueOnce({ name: "dupe-b", version: 1, enabled: true } as never)
      .mockResolvedValueOnce({ name: "dupe-a", version: 2, enabled: false } as never); // absorb-loop re-read
    vi.mocked(updateSkillIfVersion)
      .mockResolvedValueOnce({ name: "survivor", version: 2 } as never) // survivor ok
      .mockResolvedValueOnce(null) // absorb A: CAS refused — already disabled
      .mockResolvedValueOnce({ name: "dupe-b", version: 2 } as never); // absorb B ok

    const result = await dispatchGatedAction("mergeSkills", draft, { chatId: "chat-1" });

    expect(result.success).toBe(true);
    expect(result.detail).toEqual({
      skillId: SURVIVOR_ID,
      version: 2,
      archived: ["dupe-a", "dupe-b"],
    });
  });

  it("aborts with NOTHING archived when the survivor CAS fails", async () => {
    mockAbsorbeePreflightOk();
    vi.mocked(updateSkillIfVersion).mockResolvedValue(null);
    vi.mocked(getSkillById).mockResolvedValueOnce({ name: "survivor", version: 4 } as never);

    const result = await dispatchGatedAction("mergeSkills", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("version_conflict");
    // Only the survivor attempt ran — no absorbee was touched.
    expect(vi.mocked(updateSkillIfVersion)).toHaveBeenCalledTimes(1);
  });

  it("cancels the merge with state_conflict when the survivor was archived after the proposal (same version)", async () => {
    mockAbsorbeePreflightOk();
    vi.mocked(updateSkillIfVersion).mockResolvedValue(null);
    vi.mocked(getSkillById).mockResolvedValueOnce({
      name: "survivor",
      version: 1, // unchanged — archived from the dashboard, which doesn't bump it
      enabled: false,
    } as never);

    const result = await dispatchGatedAction("mergeSkills", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("state_conflict");
    expect(result.summary).toContain("merge cancelled");
    // Only the survivor attempt ran — no absorbee was touched.
    expect(vi.mocked(updateSkillIfVersion)).toHaveBeenCalledTimes(1);
  });

  it("reports a partial merge as a failure when an absorbee CAS fails after preflight (residual race)", async () => {
    mockAbsorbeePreflightOk();
    vi.mocked(updateSkillIfVersion)
      .mockResolvedValueOnce({ name: "survivor", version: 2 } as never) // survivor ok
      .mockResolvedValueOnce(null) // absorb A raced between preflight and archive
      .mockResolvedValueOnce({ name: "dupe-b", version: 2 } as never); // absorb B ok
    vi.mocked(getSkillById).mockResolvedValueOnce({ name: "dupe-a", version: 9 } as never);

    const result = await dispatchGatedAction("mergeSkills", draft, { chatId: "chat-1" });

    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("partial_merge");
    expect(result.detail).toMatchObject({
      archived: ["dupe-b"],
      failed: [{ skillId: ABSORBED_A, reason: "version_conflict" }],
    });
    // One failed absorbee doesn't stop the others from archiving.
    expect(vi.mocked(updateSkillIfVersion)).toHaveBeenCalledTimes(3);
  });

  it("rejects a self-absorbing merge before touching the db", async () => {
    const result = await dispatchGatedAction(
      "mergeSkills",
      { ...draft, absorbed: [{ skillId: SURVIVOR_ID, baseVersion: 1 }] },
      { chatId: "chat-1" },
    );
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(updateSkillIfVersion)).not.toHaveBeenCalled();
  });

  it("rejects duplicate absorbees before touching the db (second copy would CAS-fail after the survivor write)", async () => {
    const result = await dispatchGatedAction(
      "mergeSkills",
      {
        ...draft,
        absorbed: [
          { skillId: ABSORBED_A, baseVersion: 2 },
          { skillId: ABSORBED_A, baseVersion: 2 },
        ],
      },
      { chatId: "chat-1" },
    );
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(updateSkillIfVersion)).not.toHaveBeenCalled();
    expect(vi.mocked(getSkillById)).not.toHaveBeenCalled();
  });

  it("rejects a merge with no absorbed skills or no newBody", async () => {
    const noAbsorbed = await dispatchGatedAction(
      "mergeSkills",
      { ...draft, absorbed: [] },
      { chatId: "chat-1" },
    );
    expect(noAbsorbed.detail.reason).toBe("invalid_args");

    const noBody = await dispatchGatedAction(
      "mergeSkills",
      { ...draft, newBody: undefined },
      { chatId: "chat-1" },
    );
    expect(noBody.detail.reason).toBe("invalid_args");
    expect(vi.mocked(updateSkillIfVersion)).not.toHaveBeenCalled();
  });

  it("fails cleanly when chat context is missing", async () => {
    const result = await dispatchGatedAction("mergeSkills", draft);
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("no_chat_context");
    expect(vi.mocked(updateSkillIfVersion)).not.toHaveBeenCalled();
  });
});

describe("dispatchGatedAction — executeCode (dispatch-only)", () => {
  const CODE = "print(40 + 2)";

  /** A clean sandbox result the individual tests override per scenario. */
  function sandboxResult(overrides: Partial<Awaited<ReturnType<typeof runCode>>> = {}) {
    return {
      exitCode: 0,
      stdout: "42\n",
      stderr: "",
      timedOut: false,
      oomKilled: false,
      outputOverflow: false,
      output: "42",
      ...overrides,
    };
  }

  it("is dispatchable even though it is NOT in the requestConfirmation enum", () => {
    // The model can only reach it through the dedicated executeCode tool, whose
    // bubble shows the full code — never behind a ≤400-char summary.
    expect(isGatedTool("executeCode")).toBe(false);
    expect(GATED_TOOL_NAMES as readonly string[]).not.toContain("executeCode");
  });

  it("rejects an unknown language before touching the sandbox", async () => {
    const result = await dispatchGatedAction("executeCode", { language: "ruby", code: "puts 1" });
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(runCode)).not.toHaveBeenCalled();
  });

  it("re-enforces the 3000-char code cap at the dispatch boundary", async () => {
    // The tool's inputSchema also caps this, but the dispatcher is the last
    // stop before docker — it must not trust what's in the confirmation row.
    // 3000 = the bubble-fits-the-whole-program guarantee: anything larger
    // could only have been approved off a truncated preview.
    const result = await dispatchGatedAction("executeCode", {
      language: "python",
      code: "x".repeat(3001),
    });
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(runCode)).not.toHaveBeenCalled();
  });

  it("rejects NUL-bearing code at the dispatch boundary (displayed-vs-executed guard)", async () => {
    // Mirrors the tool schema: the formatter strips NULs from the approval
    // bubble, so a NUL-bearing program would execute differently than the
    // rendering the user approved.
    const result = await dispatchGatedAction("executeCode", {
      language: "python",
      code: 'print("a\u0000b")',
    });
    expect(result.success).toBe(false);
    expect(result.detail.reason).toBe("invalid_args");
    expect(vi.mocked(runCode)).not.toHaveBeenCalled();
  });

  it("refuses to run when EXECUTE_CODE_ENABLED is off (pending rows outlive a flag flip)", async () => {
    const prev = config.EXECUTE_CODE_ENABLED;
    (config as { EXECUTE_CODE_ENABLED: boolean }).EXECUTE_CODE_ENABLED = false;
    try {
      const result = await dispatchGatedAction("executeCode", {
        language: "python",
        code: CODE,
      });
      expect(result.success).toBe(false);
      expect(result.summary).toBe("code execution is disabled (EXECUTE_CODE_ENABLED is off)");
      expect(result.detail).toEqual({ reason: "disabled" });
      expect(vi.mocked(runCode)).not.toHaveBeenCalled();
    } finally {
      (config as { EXECUTE_CODE_ENABLED: boolean }).EXECUTE_CODE_ENABLED = prev;
    }
  });

  it("runs approved code and returns the capped output in detail", async () => {
    // Sandbox output keeps its real whitespace (trailing "\n" here).
    vi.mocked(runCode).mockResolvedValue(sandboxResult({ output: "42\n" }));

    const result = await dispatchGatedAction("executeCode", { language: "python", code: CODE });

    expect(result.success).toBe(true);
    // The summary trims for display only…
    expect(result.summary).toBe("code ran: 42");
    // …while detail.output and resultText stay byte-exact: resultText carries
    // the full (already ≤4000-capped) output so the acknowledgment turn can
    // relay what the code actually produced — the summary is just a preview.
    expect(result.detail).toEqual({ exitCode: 0, language: "python", output: "42\n" });
    expect(result.resultText).toBe("42\n");
    expect(vi.mocked(runCode)).toHaveBeenCalledWith({ language: "python", code: CODE });
  });

  it("logs only the code's shape — the body must never reach the log stream", async () => {
    vi.mocked(runCode).mockResolvedValue(sandboxResult());

    await dispatchGatedAction("executeCode", { language: "python", code: CODE });

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { language: "python", codeLength: CODE.length },
      "Dispatching approved executeCode",
    );
    // No log call on any level may carry the code body (keys/personal data
    // pasted into a script must not land in Kansoku).
    for (const level of [logger.info, logger.warn, logger.error, logger.debug] as const) {
      for (const call of vi.mocked(level).mock.calls) {
        expect(JSON.stringify(call)).not.toContain(CODE);
      }
    }
  });

  it("reports a non-zero exit as a failure with the output attached", async () => {
    vi.mocked(runCode).mockResolvedValue(
      sandboxResult({ exitCode: 1, stdout: "", stderr: "Traceback…", output: "Traceback…" }),
    );

    const result = await dispatchGatedAction("executeCode", { language: "python", code: CODE });

    expect(result.success).toBe(false);
    expect(result.summary).toBe("code exited with code 1");
    expect(result.detail).toEqual({
      reason: "nonzero_exit",
      exitCode: 1,
      language: "python",
      output: "Traceback…",
    });
    // Failures relay their output too — the model needs the traceback to react.
    expect(result.resultText).toBe("Traceback…");
  });

  it("reports a timeout with the configured wall-clock cap in the summary", async () => {
    vi.mocked(runCode).mockResolvedValue(
      sandboxResult({ exitCode: 137, timedOut: true, output: "partial" }),
    );

    const result = await dispatchGatedAction("executeCode", { language: "node", code: CODE });

    expect(result.success).toBe(false);
    // 120s = the EXECUTE_CODE_TIMEOUT_MS default (no env override in tests).
    expect(result.summary).toBe("code execution timed out after 120s");
    expect(result.detail).toEqual({ reason: "timeout", language: "node", output: "partial" });
  });

  it("reports an OOM kill with the configured memory cap in the summary", async () => {
    vi.mocked(runCode).mockResolvedValue(
      sandboxResult({ exitCode: 137, oomKilled: true, output: "" }),
    );

    const result = await dispatchGatedAction("executeCode", { language: "python", code: CODE });

    expect(result.success).toBe(false);
    // 512 MB = the EXECUTE_CODE_MEMORY_MB default (no env override in tests).
    expect(result.summary).toBe("code was killed (out of memory, 512 MB cap)");
    expect(result.detail).toEqual({ reason: "oom", language: "python", output: "" });
    // Empty output → no resultText; handlers fall back to the summary.
    expect(result.resultText).toBeUndefined();
  });

  it("reports an output-buffer overflow as a failed run, not success", async () => {
    // The docker client died at the 1 MB buffer cap — the program's real exit
    // status is unknown, so "code ran" would be a lie.
    vi.mocked(runCode).mockResolvedValue(
      sandboxResult({ outputOverflow: true, output: "flood…[truncated 996000]" }),
    );

    const result = await dispatchGatedAction("executeCode", { language: "python", code: CODE });

    expect(result.success).toBe(false);
    expect(result.summary).toBe("code produced too much output (1 MB cap) and was stopped");
    expect(result.detail).toEqual({
      reason: "output_overflow",
      language: "python",
      output: "flood…[truncated 996000]",
    });
  });

  it("surfaces a CodeSandboxError's friendly message instead of the generic wrapper", async () => {
    vi.mocked(runCode).mockRejectedValue(
      new CodeSandboxError(
        "daemon_unavailable",
        "Docker daemon is not running — code execution is unavailable until it's started.",
      ),
    );

    const result = await dispatchGatedAction("executeCode", { language: "python", code: CODE });

    expect(result.success).toBe(false);
    expect(result.summary).toBe(
      "Docker daemon is not running — code execution is unavailable until it's started.",
    );
    expect(result.detail).toEqual({ reason: "daemon_unavailable" });
  });
});

describe("recordProposalDeclineFromConfirmation", () => {
  it("records a decline for a createRoutine proposal (discriminates on action.tool)", async () => {
    await recordProposalDeclineFromConfirmation({
      chatId: "chat-1",
      action: { tool: "createRoutine", args: { signature: "sig#1" } },
    });

    expect(vi.mocked(recordProposalDecision)).toHaveBeenCalledWith(
      "chat-1",
      "sig#1",
      "declined",
      expect.any(Object),
    );
  });

  it("records a decline for an updateRoutinePrompt refinement", async () => {
    await recordProposalDeclineFromConfirmation({
      chatId: "chat-1",
      action: { tool: "updateRoutinePrompt", args: { signature: "refine:r#1#sig" } },
    });

    expect(vi.mocked(recordProposalDecision)).toHaveBeenCalledWith(
      "chat-1",
      "refine:r#1#sig",
      "declined",
      expect.any(Object),
    );
  });

  it("records a decline for a disableRoutine retirement", async () => {
    await recordProposalDeclineFromConfirmation({
      chatId: "chat-1",
      action: { tool: "disableRoutine", args: { signature: "retire:r#1" } },
    });

    expect(vi.mocked(recordProposalDecision)).toHaveBeenCalledWith(
      "chat-1",
      "retire:r#1",
      "declined",
      expect.any(Object),
    );
  });

  it("records a decline for a createSkill proposal in the skill proposal store", async () => {
    await recordProposalDeclineFromConfirmation({
      chatId: "chat-1",
      action: { tool: "createSkill", args: { signature: "skill#1" } },
    });

    expect(vi.mocked(recordSkillProposalDecision)).toHaveBeenCalledWith(
      "chat-1",
      "skill#1",
      "declined",
      expect.any(Object),
    );
    expect(vi.mocked(recordProposalDecision)).not.toHaveBeenCalled();
  });

  it("routes the skill curation proposals (updateSkill/disableSkill/mergeSkills) to the skill store", async () => {
    for (const [tool, signature] of [
      ["updateSkill", "skill-refine:s#1#hash"],
      ["disableSkill", "skill-archive:s#1"],
      ["mergeSkills", "skill-merge:s#1<t#1#hash"],
    ] as const) {
      await recordProposalDeclineFromConfirmation({
        chatId: "chat-1",
        action: { tool, args: { signature } },
      });
      expect(vi.mocked(recordSkillProposalDecision)).toHaveBeenCalledWith(
        "chat-1",
        signature,
        "declined",
        expect.any(Object),
      );
    }
    expect(vi.mocked(recordProposalDecision)).not.toHaveBeenCalled();
  });

  it("is a no-op for a non-proposal confirmation (e.g. a routine-raised sendEmail)", async () => {
    await recordProposalDeclineFromConfirmation({
      chatId: "chat-1",
      action: { tool: "sendEmail", args: { signature: "sig#1" } },
    });
    expect(vi.mocked(recordProposalDecision)).not.toHaveBeenCalled();
    expect(vi.mocked(recordSkillProposalDecision)).not.toHaveBeenCalled();
  });

  it("is a no-op when the signature is missing or not a string", async () => {
    await recordProposalDeclineFromConfirmation({
      chatId: "chat-1",
      action: { tool: "createRoutine", args: {} },
    });
    expect(vi.mocked(recordProposalDecision)).not.toHaveBeenCalled();
    expect(vi.mocked(recordSkillProposalDecision)).not.toHaveBeenCalled();
  });

  it("swallows a store error (best-effort — never wedges the deny path)", async () => {
    vi.mocked(recordProposalDecision).mockRejectedValue(new Error("mongo down"));
    await expect(
      recordProposalDeclineFromConfirmation({
        chatId: "chat-1",
        action: { tool: "createRoutine", args: { signature: "sig#1" } },
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows a skill proposal store error", async () => {
    vi.mocked(recordSkillProposalDecision).mockRejectedValue(new Error("mongo down"));
    await expect(
      recordProposalDeclineFromConfirmation({
        chatId: "chat-1",
        action: { tool: "createSkill", args: { signature: "skill#1" } },
      }),
    ).resolves.toBeUndefined();
  });
});
