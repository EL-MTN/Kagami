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
const INTERACTION_ID = "222222222222222222222222";

function personSummary() {
  return {
    id: PERSON_ID,
    displayName: "Sarah Chen",
    primaryEmail: "sarah@example.com",
    primaryOrgId: null,
    tags: [],
    lastInteractionAt: null,
  };
}

function followupSummary() {
  return {
    id: FOLLOWUP_ID,
    person: personSummary(),
    direction: "i_owe",
    dueAt: null,
    status: "open",
    reasonExcerpt: "Send the deck",
    reasonTruncated: false,
    sourceInteractionId: null,
  };
}

function interactionSummary() {
  return {
    id: INTERACTION_ID,
    occurredAt: "2026-05-13T12:00:00.000Z",
    channel: "call",
    title: "Catch up",
    bodyExcerpt: null,
    bodyTruncated: false,
    participants: [{ personId: PERSON_ID, role: "subject" }],
    context: [],
    status: "active",
  };
}

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
  it("defaults status=open, clamps limit, and documents Eric-relative direction", async () => {
    mockListMyFollowups.mockResolvedValue({ items: [] });

    const tool = createListMyFollowupsTool() as unknown as ExecutableTool;
    const result = await tool.execute({ direction: "i_owe", limit: 500 }, undefined);

    expect(mockListMyFollowups).toHaveBeenCalledWith({
      direction: "i_owe",
      status: "open",
      limit: 50,
    });
    expect(tool.description).toContain("i_owe means Eric owes the person");
    expect(result).toMatchObject({ success: true, count: 0, data: [] });
  });
});

describe("logInteraction CRM tool", () => {
  it("forwards the input to the client and returns the projected summary", async () => {
    const summary = interactionSummary();
    mockLogInteraction.mockResolvedValue(summary);

    const tool = createLogInteractionTool() as unknown as ExecutableTool;
    const input = {
      occurredAt: "2026-05-13T12:00:00.000Z",
      channel: "call",
      title: "Catch up",
      body: "Spoke for ~20 min",
      participants: [{ personId: PERSON_ID, role: "subject" }],
      context: ["work"],
    };
    const result = await tool.execute(input, undefined);

    expect(mockLogInteraction).toHaveBeenCalledWith(input);
    expect(result).toEqual({ success: true, data: summary });
    expect(tool.description).toContain("MUST be wrapped in requestConfirmation");
  });

  it("marks Kizuna 500 failures as degraded so the tool envelope fails open", async () => {
    mockLogInteraction.mockRejectedValue(
      new MockError("http", "Kizuna request failed with status 500", {
        status: 500,
        routeTemplate: "/interactions",
      }),
    );

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

    expect(result).toEqual({
      success: false,
      reason: "Kizuna request failed with status 500",
      degraded: true,
    });
  });
});

describe("createFollowup CRM tool", () => {
  it("forwards the input and returns the hydrated followup summary", async () => {
    const followup = followupSummary();
    mockCreateFollowup.mockResolvedValue(followup);

    const tool = createCreateFollowupTool() as unknown as ExecutableTool;
    const input = {
      personId: PERSON_ID,
      direction: "i_owe",
      reason: "Send the deck",
      dueAt: "2026-06-01T12:00:00.000Z",
    };
    const result = await tool.execute(input, undefined);

    expect(mockCreateFollowup).toHaveBeenCalledWith(input);
    expect(result).toEqual({ success: true, data: followup });
    expect(tool.description).toContain("MUST be wrapped in requestConfirmation");
  });

  it("surfaces a 404 from the package as a non-degraded tool failure (e.g. POST /followups 404 on a missing personId)", async () => {
    // The package's hydratePersonAfterWrite catches person-GET KizunaClientErrors
    // and falls back to missingPersonSummary, so a 404 reaching the tool layer
    // here represents the followups POST itself returning 404 (e.g. unknown personId).
    mockCreateFollowup.mockRejectedValue(
      new MockError("http", "Kizuna request failed with status 404", {
        status: 404,
        routeTemplate: "/followups",
      }),
    );

    const tool = createCreateFollowupTool() as unknown as ExecutableTool;
    const result = await tool.execute(
      {
        personId: PERSON_ID,
        direction: "i_owe",
        reason: "Send the deck",
      },
      undefined,
    );

    expect(result).toEqual({
      success: false,
      reason: "Kizuna request failed with status 404",
    });
  });
});

describe("resolveFollowup CRM tool", () => {
  it("forwards the followup id and target status and returns the updated summary", async () => {
    const followup = { ...followupSummary(), status: "done" };
    mockResolveFollowup.mockResolvedValue(followup);

    const tool = createResolveFollowupTool() as unknown as ExecutableTool;
    const result = await tool.execute({ followupId: FOLLOWUP_ID, status: "done" }, undefined);

    expect(mockResolveFollowup).toHaveBeenCalledWith({
      followupId: FOLLOWUP_ID,
      status: "done",
    });
    expect(result).toEqual({ success: true, data: followup });
  });
});

describe("updatePerson CRM tool", () => {
  it("forwards only the supplied fields and returns the projected summary", async () => {
    const person = personSummary();
    mockUpdatePerson.mockResolvedValue(person);

    const tool = createUpdatePersonTool() as unknown as ExecutableTool;
    const input = {
      personId: PERSON_ID,
      tags: ["close-friend"],
      notes: "lives in Brooklyn now",
    };
    const result = await tool.execute(input, undefined);

    expect(mockUpdatePerson).toHaveBeenCalledWith(input);
    expect(result).toEqual({ success: true, data: person });
  });
});
