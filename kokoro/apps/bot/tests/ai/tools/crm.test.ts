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
    MockError,
  };
});

vi.mock("@kokoro/kizuna", () => ({
  findPeople: mockFindPeople,
  getPersonContext: mockGetPersonContext,
  recentInteractions: mockRecentInteractions,
  listMyFollowups: mockListMyFollowups,
  KizunaClientError: MockError,
}));

import {
  createFindPeopleTool,
  createGetPersonContextTool,
  createListMyFollowupsTool,
  createRecentInteractionsTool,
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
});

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
