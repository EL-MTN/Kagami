import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mashiro/shared", async (orig) => ({
  ...((await orig()) as object),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const { mockListUnread, mockGetById } = vi.hoisted(() => ({
  mockListUnread: vi.fn(),
  mockGetById: vi.fn(),
}));
vi.mock("../../../src/services/gmail", () => ({
  listUnreadEmails: mockListUnread,
  getEmailById: mockGetById,
}));

import { createCheckEmailTool } from "../../../src/ai/tools/check-email";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = createCheckEmailTool() as unknown as ExecutableTool;

describe("checkEmail tool", () => {
  beforeEach(() => {
    mockListUnread.mockReset();
    mockGetById.mockReset();
  });

  it("list mode: calls listUnreadEmails with the supplied maxResults and returns count + emails", async () => {
    mockListUnread.mockResolvedValue([
      { id: "e1", subject: "hi" },
      { id: "e2", subject: "yo" },
    ]);
    const result = await tool.execute({ maxResults: 5 });
    expect(result).toEqual({
      success: true,
      count: 2,
      emails: [
        { id: "e1", subject: "hi" },
        { id: "e2", subject: "yo" },
      ],
    });
    expect(mockListUnread).toHaveBeenCalledWith(5);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("single mode: calls getEmailById when emailId is supplied — list is skipped", async () => {
    mockGetById.mockResolvedValue({ id: "e1", body: "hello" });
    const result = await tool.execute({ maxResults: 10, emailId: "e1" });
    expect(result).toEqual({ success: true, email: { id: "e1", body: "hello" } });
    expect(mockGetById).toHaveBeenCalledWith("e1");
    expect(mockListUnread).not.toHaveBeenCalled();
  });

  it("single mode: returns success:false when the email is missing", async () => {
    mockGetById.mockResolvedValue(null);
    const result = await tool.execute({ maxResults: 10, emailId: "missing" });
    expect(result).toEqual({ success: false, reason: "Email not found" });
  });

  it("returns success:false with the error message when listUnreadEmails throws", async () => {
    mockListUnread.mockRejectedValue(new Error("gmail 401"));
    const result = await tool.execute({ maxResults: 10 });
    expect(result).toEqual({ success: false, reason: "gmail 401" });
  });
});
