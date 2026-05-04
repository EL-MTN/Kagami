import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...((await orig())),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const { mockListUnread, mockGetById, mockSendEmail } = vi.hoisted(() => ({
  mockListUnread: vi.fn(),
  mockGetById: vi.fn(),
  mockSendEmail: vi.fn(),
}));
vi.mock("../../../src/services/gmail", () => ({
  listUnreadEmails: mockListUnread,
  getEmailById: mockGetById,
  sendEmail: mockSendEmail,
}));

import { createCheckEmailTool, createSendEmailTool } from "../../../src/ai/tools/email";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

beforeEach(() => {
  mockListUnread.mockReset();
  mockGetById.mockReset();
  mockSendEmail.mockReset();
});

// ─── checkEmail ──────────────────────────────────────────────────────────────

describe("checkEmail tool", () => {
  const tool = createCheckEmailTool() as unknown as ExecutableTool;

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

// ─── sendEmail ───────────────────────────────────────────────────────────────

describe("sendEmail tool", () => {
  const tool = createSendEmailTool() as unknown as ExecutableTool;

  it("calls sendEmail and returns success with the message id and threadId", async () => {
    mockSendEmail.mockResolvedValue({ id: "m-1", threadId: "t-1" });

    const result = await tool.execute({
      to: "alice@example.com",
      subject: "hi",
      body: "hello",
    });

    expect(result).toEqual({ success: true, id: "m-1", threadId: "t-1" });
    expect(mockSendEmail).toHaveBeenCalledWith("alice@example.com", "hi", "hello", undefined);
  });

  it("forwards threadId/inReplyTo when present", async () => {
    mockSendEmail.mockResolvedValue({ id: "m-2", threadId: "t-2" });
    await tool.execute({
      to: "alice@example.com",
      subject: "re: hi",
      body: "back at you",
      threadId: "t-2",
      inReplyTo: "<m-1@example.com>",
    });
    expect(mockSendEmail).toHaveBeenCalledWith("alice@example.com", "re: hi", "back at you", {
      threadId: "t-2",
      inReplyTo: "<m-1@example.com>",
    });
  });

  it("returns success:false with the error message on underlying-service failure", async () => {
    mockSendEmail.mockRejectedValue(new Error("gmail down"));
    const result = await tool.execute({
      to: "alice@example.com",
      subject: "hi",
      body: "body",
    });
    expect(result).toEqual({ success: false, reason: "gmail down" });
  });

  it("falls back to a generic reason when error is not an Error instance", async () => {
    mockSendEmail.mockRejectedValue("plain string");
    const result = await tool.execute({
      to: "alice@example.com",
      subject: "hi",
      body: "body",
    });
    expect(result).toEqual({ success: false, reason: "Failed to send email" });
  });
});
