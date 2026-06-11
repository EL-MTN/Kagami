import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig<typeof import("@kokoro/shared")>()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const {
  mockFindPeople,
  mockGetPersonContext,
  mockRecentInteractions,
  mockListMyFollowups,
  mockLogInteraction,
  mockCreateFollowup,
  mockResolveFollowup,
  mockUpdatePerson,
  MockError,
} = vi.hoisted(() => {
  class MockError extends Error {
    readonly status?: number;
    readonly routeTemplate?: string;
    constructor(
      readonly kind: string,
      readonly safeMessage: string,
      metadata: { status?: number; routeTemplate?: string } = {},
    ) {
      super(safeMessage);
      this.name = "KizunaClientError";
      this.status = metadata.status;
      this.routeTemplate = metadata.routeTemplate;
    }
  }
  return {
    mockFindPeople: vi.fn(),
    mockGetPersonContext: vi.fn(),
    mockRecentInteractions: vi.fn(),
    mockListMyFollowups: vi.fn(),
    mockLogInteraction: vi.fn(),
    mockCreateFollowup: vi.fn(),
    mockResolveFollowup: vi.fn(),
    mockUpdatePerson: vi.fn(),
    MockError,
  };
});

vi.mock("@kokoro/kizuna", () => ({
  findPeople: mockFindPeople,
  getPersonContext: mockGetPersonContext,
  recentInteractions: mockRecentInteractions,
  listMyFollowups: mockListMyFollowups,
  logInteraction: mockLogInteraction,
  createFollowup: mockCreateFollowup,
  resolveFollowup: mockResolveFollowup,
  updatePerson: mockUpdatePerson,
  KizunaClientError: MockError,
}));

import {
  createCreateFollowupTool,
  createFindPeopleTool,
  createGetPersonContextTool,
  createListMyFollowupsTool,
  createLogInteractionTool,
  createRecentInteractionsTool,
  createResolveFollowupTool,
  createUpdatePersonTool,
} from "../../../src/ai/tools/crm";

interface ExecutableTool {
  description?: string;
  execute: (input: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockFindPeople.mockReset();
  mockGetPersonContext.mockReset();
  mockRecentInteractions.mockReset();
  mockListMyFollowups.mockReset();
  mockLogInteraction.mockReset();
  mockCreateFollowup.mockReset();
  mockResolveFollowup.mockReset();
  mockUpdatePerson.mockReset();
});

const PERSON_ID = "111111111111111111111111";
const FOLLOWUP_ID = "333333333333333333333333";

describe("findPeople CRM tool", () => {
  it("trims query, clamps limit, and returns count/truncation metadata", async () => {
    mockFindPeople.mockResolvedValue({
      items: [
        {
          id: "111111111111111111111111",
          displayName: "Sarah Chen",
          primaryEmail: "sarah@example.com",
          primaryOrgId: null,
          tags: [],
          lastInteractionAt: null,
        },
      ],
      nextCursor: "more",
    });

    const tool = createFindPeopleTool() as unknown as ExecutableTool;
    const result = await tool.execute({ query: " Sarah ", limit: 99 }, undefined);

    expect(mockFindPeople).toHaveBeenCalledWith({ query: "Sarah", limit: 20 });
    expect(result).toMatchObject({
      success: true,
      count: 1,
      truncated: true,
    });
    expect(result.data).toHaveLength(1);
  });

  it("returns a non-degraded local validation failure without calling Kizuna", async () => {
    const tool = createFindPeopleTool() as unknown as ExecutableTool;
    const result = await tool.execute({ query: "   " }, undefined);

    expect(mockFindPeople).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, reason: "query is required" });
  });
});

describe("recentInteractions CRM tool", () => {
  it("forwards filters with clamped limit and unwraps the package envelope", async () => {
    mockRecentInteractions.mockResolvedValue({ items: [], nextCursor: "more" });

    const tool = createRecentInteractionsTool() as unknown as ExecutableTool;
    const result = await tool.execute(
      {
        personId: "111111111111111111111111",
        channel: "email",
        since: "2026-01-01T00:00:00.000Z",
        limit: -1,
      },
      undefined,
    );

    expect(mockRecentInteractions).toHaveBeenCalledWith({
      personId: "111111111111111111111111",
      channel: "email",
      since: "2026-01-01T00:00:00.000Z",
      limit: 1,
    });
    expect(result).toMatchObject({ success: true, count: 0, truncated: true, data: [] });
  });
});

describe("getPersonContext CRM tool", () => {
  it("treats primary 404 as a non-degraded tool failure", async () => {
    mockGetPersonContext.mockRejectedValue(
      new MockError("http", "Kizuna request failed with status 404", {
        status: 404,
        routeTemplate: "/people/:id",
      }),
    );

    const tool = createGetPersonContextTool() as unknown as ExecutableTool;
    const result = await tool.execute({ personId: "111111111111111111111111" }, undefined);

    expect(result).toEqual({
      success: false,
      reason: "Kizuna request failed with status 404",
    });
  });

  it("marks upstream 429 failures as degraded", async () => {
    mockGetPersonContext.mockRejectedValue(
      new MockError("http", "Kizuna request failed with status 429", {
        status: 429,
        routeTemplate: "/people/:id",
      }),
    );

    const tool = createGetPersonContextTool() as unknown as ExecutableTool;
    const result = await tool.execute({ personId: "111111111111111111111111" }, undefined);

    expect(result).toEqual({
      success: false,
      reason: "Kizuna request failed with status 429",
      degraded: true,
    });
  });
});

describe("listMyFollowups CRM tool", () => {
  it("defaults status=open, clamps limit, and documents Goshujin-sama-relative direction", async () => {
    mockListMyFollowups.mockResolvedValue({ items: [] });

    const tool = createListMyFollowupsTool() as unknown as ExecutableTool;
    const result = await tool.execute({ direction: "i_owe", limit: 500 }, undefined);

    expect(mockListMyFollowups).toHaveBeenCalledWith({
      direction: "i_owe",
      status: "open",
      limit: 50,
    });
    expect(tool.description).toContain("i_owe means Goshujin-sama owes the person");
    expect(result).toMatchObject({ success: true, count: 0, data: [] });
  });
});

// CRM write tools enforce the confirmation gate at the code level: each
// tool's `execute` returns a refusal envelope instead of calling the
// Kizuna client. The dispatcher in `services/gated-actions.ts` calls the
// client directly after approval, so the dispatch path is unaffected.
//
// These tests pin that contract from the LLM-facing side. The kizuna
// package mocks must NEVER be called from these write paths.

describe("logInteraction CRM tool", () => {
  it("refuses direct invocation and instructs the LLM to wrap in requestConfirmation", async () => {
    const tool = createLogInteractionTool() as unknown as ExecutableTool;
    const result = await tool.execute(
      {
        occurredAt: "2026-05-13T12:00:00.000Z",
        channel: "call",
        title: "Catch up",
        participants: [{ personId: PERSON_ID, role: "subject" }],
      },
      undefined,
    );

    expect(mockLogInteraction).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.reason).toContain("approval-gated");
    expect(result.reason).toContain("requestConfirmation");
    expect(result.reason).toContain('"logInteraction"');
    expect(tool.description).toContain("MUST be wrapped in requestConfirmation");
  });
});

describe("createFollowup CRM tool", () => {
  it("refuses direct invocation and instructs the LLM to wrap in requestConfirmation", async () => {
    const tool = createCreateFollowupTool() as unknown as ExecutableTool;
    const result = await tool.execute(
      {
        personId: PERSON_ID,
        direction: "i_owe",
        reason: "Send the deck",
      },
      undefined,
    );

    expect(mockCreateFollowup).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.reason).toContain('"createFollowup"');
    expect(tool.description).toContain("MUST be wrapped in requestConfirmation");
  });
});

describe("resolveFollowup CRM tool", () => {
  it("refuses direct invocation and instructs the LLM to wrap in requestConfirmation", async () => {
    const tool = createResolveFollowupTool() as unknown as ExecutableTool;
    const result = await tool.execute({ followupId: FOLLOWUP_ID, status: "done" }, undefined);

    expect(mockResolveFollowup).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.reason).toContain('"resolveFollowup"');
  });
});

describe("updatePerson CRM tool", () => {
  it("refuses direct invocation and instructs the LLM to wrap in requestConfirmation", async () => {
    const tool = createUpdatePersonTool() as unknown as ExecutableTool;
    const result = await tool.execute(
      {
        personId: PERSON_ID,
        tags: ["close-friend"],
      },
      undefined,
    );

    expect(mockUpdatePerson).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.reason).toContain('"updatePerson"');
  });
});
