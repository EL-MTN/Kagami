import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kokoro/shared", async (orig) => ({
  ...(await orig()),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const { mockListEmails, mockGetById, mockGetOwnerAddress, mockSendEmail } = vi.hoisted(() => ({
  mockListEmails: vi.fn(),
  mockGetById: vi.fn(),
  mockGetOwnerAddress: vi.fn(),
  mockSendEmail: vi.fn(),
}));
vi.mock("../../../src/services/gmail", () => ({
  listEmails: mockListEmails,
  getEmailById: mockGetById,
  getOwnerAddress: mockGetOwnerAddress,
  sendEmail: mockSendEmail,
}));

import { createCheckEmailTool, createSendEmailTool } from "../../../src/ai/tools/email";

interface ExecutableTool {
  execute: (input: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>>;
}

const OWNER_ADDRESS = "owner@example.com";

beforeEach(() => {
  mockListEmails.mockReset();
  mockGetById.mockReset();
  mockGetOwnerAddress.mockReset();
  mockSendEmail.mockReset();
  mockGetOwnerAddress.mockResolvedValue(OWNER_ADDRESS);
});

// ─── checkEmail ──────────────────────────────────────────────────────────────

describe("checkEmail tool", () => {
  const tool = createCheckEmailTool() as unknown as ExecutableTool;

  it("list mode: defaults to the unread query and returns count + emails", async () => {
    mockListEmails.mockResolvedValue([
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
    expect(mockListEmails).toHaveBeenCalledWith("is:unread", 5);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("search mode: forwards a Gmail query verbatim", async () => {
    mockListEmails.mockResolvedValue([{ id: "e3" }]);
    const result = await tool.execute({
      maxResults: 10,
      query: "from:alice@example.com newer_than:7d",
    });
    expect(result).toMatchObject({ success: true, count: 1 });
    expect(mockListEmails).toHaveBeenCalledWith("from:alice@example.com newer_than:7d", 10);
  });

  it("treats a blank/whitespace query as the unread default (a bare q lists the whole mailbox)", async () => {
    mockListEmails.mockResolvedValue([]);
    await tool.execute({ maxResults: 10, query: "   " });
    expect(mockListEmails).toHaveBeenCalledWith("is:unread", 10);
  });

  it("single mode: calls getEmailById when emailId is supplied — list is skipped", async () => {
    mockGetById.mockResolvedValue({ id: "e1", body: "hello" });
    const result = await tool.execute({ maxResults: 10, emailId: "e1" });
    expect(result).toEqual({ success: true, email: { id: "e1", body: "hello" } });
    expect(mockGetById).toHaveBeenCalledWith("e1");
    expect(mockListEmails).not.toHaveBeenCalled();
  });

  it("single mode: returns success:false when the email is missing", async () => {
    mockGetById.mockResolvedValue(null);
    const result = await tool.execute({ maxResults: 10, emailId: "missing" });
    expect(result).toEqual({ success: false, reason: "Email not found" });
  });

  it("returns success:false with the error message when listEmails throws", async () => {
    mockListEmails.mockRejectedValue(new Error("gmail 401"));
    const result = await tool.execute({ maxResults: 10 });
    expect(result).toEqual({ success: false, reason: "gmail 401" });
  });
});

// ─── sendEmail ───────────────────────────────────────────────────────────────

describe("sendEmail tool — self-send carve-out", () => {
  const tool = createSendEmailTool() as unknown as ExecutableTool;

  it("sends directly when addressed to the owner's own address with no cc/bcc", async () => {
    mockSendEmail.mockResolvedValue({ id: "m-1", threadId: "t-1" });

    const result = await tool.execute({
      to: OWNER_ADDRESS,
      subject: "note to self",
      body: "remember the thing",
    });

    expect(result).toEqual({ success: true, id: "m-1", threadId: "t-1" });
    expect(mockSendEmail).toHaveBeenCalledWith(
      OWNER_ADDRESS,
      "note to self",
      "remember the thing",
      undefined,
    );
  });

  it("matches the owner address case-insensitively", async () => {
    mockSendEmail.mockResolvedValue({ id: "m-1", threadId: "t-1" });
    const result = await tool.execute({
      to: "Owner@Example.com",
      subject: "s",
      body: "b",
    });
    expect(result).toMatchObject({ success: true });
  });

  it("forwards threadId/inReplyTo on a self send", async () => {
    mockSendEmail.mockResolvedValue({ id: "m-2", threadId: "t-2" });
    await tool.execute({
      to: OWNER_ADDRESS,
      subject: "re: hi",
      body: "back at you",
      threadId: "t-2",
      inReplyTo: "<m-1@example.com>",
    });
    expect(mockSendEmail).toHaveBeenCalledWith(OWNER_ADDRESS, "re: hi", "back at you", {
      threadId: "t-2",
      inReplyTo: "<m-1@example.com>",
    });
  });

  it("refuses a direct send to anyone else and points at requestConfirmation", async () => {
    const result = await tool.execute({
      to: "alice@example.com",
      subject: "hi",
      body: "hello",
    });
    expect(result.success).toBe(false);
    expect(result.reason as string).toContain("requestConfirmation");
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("refuses a self-addressed send that carries cc or bcc", async () => {
    const withCc = await tool.execute({
      to: OWNER_ADDRESS,
      subject: "s",
      body: "b",
      cc: ["alice@example.com"],
    });
    expect(withCc.success).toBe(false);

    const withBcc = await tool.execute({
      to: OWNER_ADDRESS,
      subject: "s",
      body: "b",
      bcc: ["bob@example.com"],
    });
    expect(withBcc.success).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("refuses when the owner address cannot be resolved (null profile)", async () => {
    mockGetOwnerAddress.mockResolvedValue(null);
    const result = await tool.execute({
      to: OWNER_ADDRESS,
      subject: "s",
      body: "b",
    });
    expect(result.success).toBe(false);
    expect(result.reason as string).toContain("requestConfirmation");
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns success:false with the error message on underlying-service failure", async () => {
    mockSendEmail.mockRejectedValue(new Error("gmail down"));
    const result = await tool.execute({
      to: OWNER_ADDRESS,
      subject: "hi",
      body: "body",
    });
    expect(result).toEqual({ success: false, reason: "gmail down" });
  });

  it("falls back to a generic reason when error is not an Error instance", async () => {
    mockSendEmail.mockRejectedValue("plain string");
    const result = await tool.execute({
      to: OWNER_ADDRESS,
      subject: "hi",
      body: "body",
    });
    expect(result).toEqual({ success: false, reason: "Failed to send email" });
  });
});
