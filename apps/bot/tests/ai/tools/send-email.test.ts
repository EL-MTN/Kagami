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

const { mockSendEmail } = vi.hoisted(() => ({ mockSendEmail: vi.fn() }));
vi.mock("../../../src/services/gmail", () => ({ sendEmail: mockSendEmail }));

import { createSendEmailTool } from "../../../src/ai/tools/send-email";

interface ExecutableTool {
  execute: (
    input: Record<string, unknown>,
    options?: unknown,
  ) => Promise<Record<string, unknown>>;
}

const tool = createSendEmailTool() as unknown as ExecutableTool;

describe("sendEmail tool", () => {
  beforeEach(() => {
    mockSendEmail.mockReset();
  });

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
    expect(mockSendEmail).toHaveBeenCalledWith(
      "alice@example.com",
      "re: hi",
      "back at you",
      { threadId: "t-2", inReplyTo: "<m-1@example.com>" },
    );
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
